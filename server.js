const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// ============================================================
// КОНФИГ из переменных окружения Railway
// ============================================================
const WAZZUP_API_KEY = process.env.WAZZUP_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL; // https://primebuilding.bitrix24.kz/rest/19217/3epxjmfjsvhmr5m/
const BITRIX_BOT_USER_ID = process.env.BITRIX_BOT_USER_ID || '19217';
const BOT_SYSTEM_PROMPT = process.env.BOT_SYSTEM_PROMPT || 'Ты вежливый помощник.';

// Рабочее время (Астана UTC+5)
const WORK_HOURS = {
  weekdays: { start: 9, end: 19 },   // Пн-Пт 09:00-19:00
  weekends: { start: 10, end: 18 },  // Сб-Вс 10:00-18:00
};

// ============================================================
// ИСТОРИЯ ЧАТОВ
// ============================================================
const chatHistory = {};
const processedMessages = new Set(); // защита от дублей

function getHistory(chatId) {
  if (!chatHistory[chatId]) chatHistory[chatId] = [];
  return chatHistory[chatId].slice(-20);
}

function addToHistory(chatId, role, content) {
  if (!chatHistory[chatId]) chatHistory[chatId] = [];
  chatHistory[chatId].push({ role, content });
  if (chatHistory[chatId].length > 100) {
    chatHistory[chatId] = chatHistory[chatId].slice(-100);
  }
}

// ============================================================
// ПРОВЕРКА РАБОЧЕГО ВРЕМЕНИ (UTC+5 Астана)
// ============================================================
function isWorkingHours() {
  const now = new Date();
  const astanaHour = (now.getUTCHours() + 5) % 24;
  const astanaDay = new Date(now.getTime() + 5 * 60 * 60 * 1000).getUTCDay();
  
  const isWeekend = astanaDay === 0 || astanaDay === 6;
  const hours = isWeekend ? WORK_HOURS.weekends : WORK_HOURS.weekdays;
  
  return astanaHour >= hours.start && astanaHour < hours.end;
}

// ============================================================
// ПРОВЕРКА — ВЗЯЛ ЛИ МЕНЕДЖЕР СДЕЛКУ В БИТРИКС24
// ============================================================
async function isManagerActive(chatId) {
  if (!BITRIX_WEBHOOK_URL) return false;
  try {
    const phone = chatId.replace(/\D/g, '');
    const response = await axios.get(`${BITRIX_WEBHOOK_URL}/crm.deal.list.json`, {
      params: {
        filter: { 'PHONE': phone, 'STAGE_ID': 'NEW' },
        select: ['ID', 'ASSIGNED_BY_ID', 'STAGE_ID'],
      },
    });
    const deals = response.data?.result || [];
    if (deals.length === 0) return false;
    const deal = deals[0];
    // Если ответственный не бот — менеджер взял
    return String(deal.ASSIGNED_BY_ID) !== String(BITRIX_BOT_USER_ID);
  } catch (err) {
    console.error('Ошибка Битрикс24:', err.message);
    return false;
  }
}

// ============================================================
// ЗАПРОС К OPENAI
// ============================================================
async function askOpenAI(chatId, userMessage) {
  addToHistory(chatId, 'user', userMessage);
  const history = getHistory(chatId);

  const workingHours = isWorkingHours();
  const timeContext = workingHours
    ? 'Сейчас рабочее время. Ты можешь предложить клиенту связаться с менеджером прямо сейчас.'
    : 'Сейчас нерабочее время. Собери контактные данные клиента и скажи что менеджер свяжется утром.';

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: `${BOT_SYSTEM_PROMPT}\n\n${timeContext}` },
        ...history,
      ],
      max_tokens: 1024,
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const reply = response.data.choices[0].message.content;
  addToHistory(chatId, 'assistant', reply);
  return reply;
}

// ============================================================
// ОТПРАВКА ЧЕРЕЗ WAZZUP
// ============================================================
async function sendMessage(chatId, channelId, text) {
  await axios.post(
    'https://api.wazzup24.com/v3/message',
    { channelId, chatId, text },
    {
      headers: {
        Authorization: `Bearer ${WAZZUP_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

// ============================================================
// ПЕРЕСЫЛКА В БИТРИКС24 (чтобы CRM продолжала работать)
// ============================================================
async function forwardToBitrix(body) {
  if (!BITRIX_WEBHOOK_URL) return;
  try {
    await axios.post(`${BITRIX_WEBHOOK_URL}/imconnector.receive.json`, body);
  } catch (err) {
    console.error('Ошибка пересылки в Битрикс24:', err.message);
  }
}

// ============================================================
// WEBHOOK ОТ WAZZUP — главная точка входа
// ============================================================
app.post('/webhook/wazzup', async (req, res) => {
  res.sendStatus(200);

  // Пересылаем в Битрикс24 сразу — чтобы CRM работала как раньше
  forwardToBitrix(req.body);

  try {
    const messages = req.body?.messages || [];

    for (const msg of messages) {
      if (msg.messageKind !== 'incoming') continue;
      const text = msg.text || msg.caption;
      if (!text) continue;

      // Защита от дублей
      if (processedMessages.has(msg.id)) continue;
      processedMessages.add(msg.id);
      setTimeout(() => processedMessages.delete(msg.id), 60000);

      const chatId = msg.chatId;
      const channelId = msg.channelId;

      console.log(`[${new Date().toISOString()}] От ${chatId}: ${text}`);

      // Проверяем менеджера
      const managerActive = await isManagerActive(chatId);
      if (managerActive) {
        console.log(`[${chatId}] Менеджер активен — бот молчит`);
        continue;
      }

      // Отвечает бот
      console.log(`[${chatId}] Рабочее время: ${isWorkingHours()} — бот отвечает`);
      const reply = await askOpenAI(chatId, text);
      await sendMessage(chatId, channelId, reply);
      console.log(`[${chatId}] Ответ отправлен`);
    }
  } catch (err) {
    console.error('Ошибка:', err.message);
  }
});

// Healthcheck
app.get('/health', (req, res) => res.json({
  status: 'ok',
  time: new Date(),
  workingHours: isWorkingHours()
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Бот запущен на порту ${PORT}`));
