const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// ============================================================
// КОНФИГ — заполни в config.js
// ============================================================
const config = require('./config');

// ============================================================
// ХРАНИЛИЩЕ ИСТОРИИ ЧАТОВ (в памяти, можно заменить на Redis)
// ============================================================
const chatHistory = {}; // { chatId: [ {role, content}, ... ] }

// ============================================================
// УТИЛИТЫ
// ============================================================

// Получить историю чата (последние N сообщений)
function getHistory(chatId) {
  if (!chatHistory[chatId]) chatHistory[chatId] = [];
  return chatHistory[chatId].slice(-20); // последние 20 сообщений
}

// Добавить сообщение в историю
function addToHistory(chatId, role, content) {
  if (!chatHistory[chatId]) chatHistory[chatId] = [];
  chatHistory[chatId].push({ role, content });
  // Ограничиваем историю 100 сообщениями
  if (chatHistory[chatId].length > 100) {
    chatHistory[chatId] = chatHistory[chatId].slice(-100);
  }
}

// ============================================================
// ПРОВЕРКА МЕНЕДЖЕРА В БИТРИКС24
// Возвращает true если менеджер уже назначен (бот должен молчать)
// ============================================================
async function isManagerAssigned(chatId) {
  try {
    // Ищем открытый лид/сделку по внешнему ID чата
    const response = await axios.get(
      `${config.BITRIX_WEBHOOK_URL}/crm.lead.list.json`,
      {
        params: {
          filter: {
            'UF_CRM_WAZZUP_CHAT_ID': chatId, // кастомное поле — см. инструкцию
            'STATUS_ID': 'IN_PROCESS',       // статус "в работе"
          },
          select: ['ID', 'ASSIGNED_BY_ID'],
        },
      }
    );

    const leads = response.data?.result || [];
    if (leads.length === 0) return false;

    const lead = leads[0];
    // Если назначен менеджер (не дефолтный пользователь) — бот молчит
    return lead.ASSIGNED_BY_ID && lead.ASSIGNED_BY_ID !== config.BITRIX_BOT_USER_ID;
  } catch (err) {
    console.error('Ошибка проверки Битрикс24:', err.message);
    // При ошибке — даём боту отвечать (fail open)
    return false;
  }
}

// ============================================================
// ЗАПРОС К CLAUDE API
// ============================================================
async function askClaude(chatId, userMessage) {
  addToHistory(chatId, 'user', userMessage);
  const history = getHistory(chatId);

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: config.BOT_SYSTEM_PROMPT,
      messages: history,
    },
    {
      headers: {
        'x-api-key': config.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    }
  );

  const reply = response.data.content[0].text;
  addToHistory(chatId, 'assistant', reply);
  return reply;
}

// ============================================================
// ОТПРАВКА ОТВЕТА ЧЕРЕЗ WAZZUP
// ============================================================
async function sendMessage(chatId, channelId, text) {
  await axios.post(
    'https://api.wazzup24.com/v3/message',
    {
      channelId,
      chatId,
      text,
    },
    {
      headers: {
        Authorization: `Bearer ${config.WAZZUP_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

// ============================================================
// WEBHOOK ОТ WAZZUP — главная точка входа
// ============================================================
app.post('/webhook/wazzup', async (req, res) => {
  // Сразу отвечаем 200 чтобы Wazzup не ретраил
  res.sendStatus(200);

  try {
    const messages = req.body?.messages || [];

    for (const msg of messages) {
      // Пропускаем исходящие (от нас самих)
      if (msg.messageKind !== 'incoming') continue;

      // Поддерживаемые типы сообщений
      const text = msg.text || msg.caption;
      if (!text) continue;

      const chatId = msg.chatId;
      const channelId = msg.channelId;

      console.log(`[${new Date().toISOString()}] Входящее от ${chatId}: ${text}`);

      // Проверяем — работает ли уже менеджер с этим чатом
      const managerActive = await isManagerAssigned(chatId);

      if (managerActive) {
        console.log(`[${chatId}] Менеджер активен — бот молчит`);
        continue;
      }

      // Менеджера нет — отвечает бот
      console.log(`[${chatId}] Бот отвечает...`);
      const reply = await askClaude(chatId, text);
      await sendMessage(chatId, channelId, reply);
      console.log(`[${chatId}] Ответ отправлен: ${reply.slice(0, 80)}...`);
    }
  } catch (err) {
    console.error('Ошибка обработки webhook:', err.message);
  }
});

// ============================================================
// WEBHOOK ОТ БИТРИКС24 — событие смены ответственного
// Когда менеджер берёт чат, можно послать приветственное сообщение
// ============================================================
app.post('/webhook/bitrix', async (req, res) => {
  res.sendStatus(200);
  try {
    const event = req.body;
    // EVENT_TYPE: ONCRMLEADUPDATE, ONCRMDEALUPDATE и т.д.
    console.log('Битрикс событие:', JSON.stringify(event).slice(0, 200));
    // Здесь можно добавить логику — например, очистить историю чата
    // когда менеджер закрывает сделку и бот снова становится активным
  } catch (err) {
    console.error('Ошибка bitrix webhook:', err.message);
  }
});

// Healthcheck
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Бот запущен на порту ${PORT}`);
  console.log(`Webhook URL: POST /webhook/wazzup`);
});
