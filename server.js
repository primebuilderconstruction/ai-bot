const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// ============================================================
// КОНФИГ — берётся из переменных окружения Railway
// ============================================================
const WAZZUP_API_KEY = process.env.WAZZUP_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL;
const BITRIX_BOT_USER_ID = process.env.BITRIX_BOT_USER_ID || '1';
const BOT_SYSTEM_PROMPT = process.env.BOT_SYSTEM_PROMPT || 'Ты вежливый помощник компании. Отвечай кратко и по делу.';

// ============================================================
// ИСТОРИЯ ЧАТОВ (в памяти)
// ============================================================
const chatHistory = {};

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
// ПРОВЕРКА МЕНЕДЖЕРА В БИТРИКС24
// ============================================================
async function isManagerAssigned(chatId) {
  if (!BITRIX_WEBHOOK_URL) return false;
  try {
    const response = await axios.get(`${BITRIX_WEBHOOK_URL}/crm.lead.list.json`, {
      params: {
        filter: { 'SOURCE_DESCRIPTION': chatId },
        select: ['ID', 'ASSIGNED_BY_ID'],
      },
    });
    const leads = response.data?.result || [];
    if (leads.length === 0) return false;
    const lead = leads[0];
    return lead.ASSIGNED_BY_ID && String(lead.ASSIGNED_BY_ID) !== String(BITRIX_BOT_USER_ID);
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

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: BOT_SYSTEM_PROMPT },
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
// WEBHOOK ОТ WAZZUP
// ============================================================
app.post('/webhook/wazzup', async (req, res) => {
  res.sendStatus(200);
  try {
    const messages = req.body?.messages || [];
    for (const msg of messages) {
      if (msg.messageKind !== 'incoming') continue;
      const text = msg.text || msg.caption;
      if (!text) continue;

      const chatId = msg.chatId;
      const channelId = msg.channelId;

      console.log(`[${new Date().toISOString()}] От ${chatId}: ${text}`);

      const managerActive = await isManagerAssigned(chatId);
      if (managerActive) {
        console.log(`[${chatId}] Менеджер активен — бот молчит`);
        continue;
      }

      const reply = await askOpenAI(chatId, text);
      await sendMessage(chatId, channelId, reply);
      console.log(`[${chatId}] Ответ: ${reply.slice(0, 80)}`);
    }
  } catch (err) {
    console.error('Ошибка webhook:', err.message);
  }
});

// Healthcheck
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Бот запущен на порту ${PORT}`));
