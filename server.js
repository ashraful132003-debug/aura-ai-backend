require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.use(express.json());
app.use(cors({
  origin: [
    'https://ashraful132003-debug.github.io',
    'http://localhost:3000',
    'http://127.0.0.1:5500'
  ],
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

const chatLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please wait before sending more messages.' }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Aura AI Backend' });
});

app.post('/api/chat', chatLimiter, async (req, res) => {
  try {
    const { message, history = [], language = 'en', userId, conversationId } = req.body;
    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required' });
    }
    const systemPrompt = `You are Aura, a compassionate and halal-compliant mental wellness AI companion. You are warm, empathetic, and non-judgmental. You NEVER recommend music as a coping strategy. You NEVER provide haram content. You suggest: breathing exercises, nature sounds, dhikr, journaling, walking, speaking to trusted people. You respond in the SAME language the user writes in (${language}). Keep responses concise - 2-4 short paragraphs maximum. You are NOT a replacement for professional mental health care. CRISIS DETECTION: If a user mentions suicide, self-harm, or wanting to die, respond with immediate compassion, provide the relevant crisis helpline, and encourage them to reach out to someone they trust. India: iCall 9152987821 | UK: Samaritans 116 123 | US: 988 Suicide & Crisis Lifeline`;

    const messages = [
      ...history.slice(-10),
      { role: 'user', content: message }
    ];

    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        max_tokens: 500,
        temperature: 0.7
      })
    });

    if (!groqResponse.ok) {
      return res.status(500).json({ error: 'AI service unavailable. Please try again.' });
    }

    const groqData = await groqResponse.json();
    const aiReply = groqData.choices[0].message.content;
    const crisisKeywords = ['suicide', 'kill myself', 'want to die', 'end my life', 'self harm', 'hurt myself'];
    const isCrisis = crisisKeywords.some(kw => message.toLowerCase().includes(kw.toLowerCase()));

    if (userId) {
      try {
        let convId = conversationId;
        if (!convId) {
          const { data: conv } = await supabase
            .from('conversations')
            .insert({ user_id: userId, title: message.substring(0, 50), language })
            .select().single();
          convId = conv?.id;
        }
        if (convId) {
          await supabase.from('messages').insert({ conversation_id: convId, role: 'user', content: message, language });
          await supabase.from('messages').insert({ conversation_id: convId, role: 'assistant', content: aiReply, language });
          await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', convId);
          if (isCrisis) {
            await supabase.from('crisis_flags').insert({ user_id: userId, message_snippet: message.substring(0, 200) });
          }
        }
        res.json({ reply: aiReply, conversationId: convId, isCrisis });
      } catch (dbErr) {
        res.json({ reply: aiReply, conversationId: null, isCrisis });
      }
    } else {
      res.json({ reply: aiReply, conversationId: null, isCrisis });
    }
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/mood', async (req, res) => {
  try {
    const { mood, userId } = req.body;
    if (!mood) return res.status(400).json({ error: 'Mood is required' });
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: 'You are Aura, a halal mental wellness AI. Give a single short (2-3 sentence) compassionate recommendation. Never recommend music. Suggest breathing, nature sounds, dhikr, journaling, or gentle movement. Also give a clarity score from 0-100. Respond in JSON only: {"recommendation": "...", "clarity_score": 75}' },
          { role: 'user', content: `I am feeling: ${mood}` }
        ],
        max_tokens: 150,
        temperature: 0.7
      })
    });
    const groqData = await groqResponse.json();
    let recommendation = 'Take a moment to breathe deeply and be kind to yourself.';
    let clarityScore = 50;
    try {
      const parsed = JSON.parse(groqData.choices[0].message.content);
      recommendation = parsed.recommendation || recommendation;
      clarityScore = parsed.clarity_score || clarityScore;
    } catch (e) {
      recommendation = groqData.choices[0].message.content;
    }
    if (userId) {
      await supabase.from('mood_logs').insert({ user_id: userId, mood, ai_recommendation: recommendation, clarity_score: clarityScore });
    }
    res.json({ recommendation, clarityScore });
  } catch (err) {
    res.status(500).json({ error: 'Could not process mood. Please try again.' });
  }
});

app.get('/api/mood/history', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const { data, error } = await supabase.from('mood_logs').select('mood, clarity_score, logged_at').eq('user_id', userId).gte('logged_at', thirtyDaysAgo.toISOString()).order('logged_at', { ascending: false });
    if (error) throw error;
    res.json({ history: data });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch mood history.' });
  }
});

app.get('/api/conversations', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const { data, error } = await supabase.from('conversations').select('id, title, language, created_at, updated_at').eq('user_id', userId).order('updated_at', { ascending: false }).limit(50);
    if (error) throw error;
    res.json({ conversations: data });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch conversations.' });
  }
});

app.get('/api/conversations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.query;
    const { data: conv } = await supabase.from('conversations').select('id').eq('id', id).eq('user_id', userId).single();
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    const { data, error } = await supabase.from('messages').select('role, content, sent_at').eq('conversation_id', id).order('sent_at', { ascending: true });
    if (error) throw error;
    res.json({ messages: data });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch messages.' });
  }
});

app.delete('/api/conversations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.query;
    await supabase.from('messages').delete().eq('conversation_id', id);
    await supabase.from('conversations').delete().eq('id', id).eq('user_id', userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete conversation.' });
  }
});

app.listen(PORT, () => {
  console.log(`Aura AI backend running on port ${PORT}`);
});
