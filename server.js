const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://supabase.vibecoding.by';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getAdmin() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

async function getSettings(keys) {
  const supabase = getAdmin();
  const map = {};
  try {
    const { data } = await supabase.from('system_settings').select('key, value').in('key', keys);
    for (const row of (data || [])) map[row.key] = row.value;
  } catch (e) { console.error('getSettings error:', e.message); }
  return map;
}

async function sendResend(apiKey, emailData) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(emailData)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Resend API error');
  return data;
}

async function logEmail(data) {
  try {
    const supabase = getAdmin();
    await supabase.from('email_logs').insert({
      id: crypto.randomUUID(),
      resend_email_id: data.resend_email_id || '',
      recipient_email: data.recipient_email,
      subject: data.subject,
      template_type: data.template_type,
      status: data.status,
      error_message: data.error_message || '',
      metadata: JSON.stringify(data.metadata || {}),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
  } catch (e) { console.error('logEmail error:', e.message); }
}

// 1. UPLOAD IMAGE
app.post('/upload-image', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const type = req.body.type || 'general';
    if (!file) return res.status(400).json({ error: 'No file provided' });
    const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
    const allowed = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
    if (!allowed.includes(ext)) return res.status(400).json({ error: 'Invalid file type' });

    const supabase = getAdmin();
    const fileName = `${type}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    const fileBuffer = fs.readFileSync(file.path);
    const mimeTypes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

    const { data, error } = await supabase.storage
      .from('images')
      .upload(fileName, fileBuffer, { contentType: mimeTypes[ext] || 'application/octet-stream', upsert: false });

    fs.unlinkSync(file.path);
    if (error) throw new Error(error.message);

    const { data: urlData } = supabase.storage.from('images').getPublicUrl(data.path);
    res.json({ url: urlData.publicUrl });
  } catch (e) { console.error('upload-image error:', e); res.status(500).json({ error: e.message }); }
});

// 2. SEND EMAIL
app.post('/send-email', async (req, res) => {
  try {
    const settings = await getSettings(['resend_api_key', 'resend_from_email', 'resend_from_name', 'resend_reply_to']);
    if (!settings.resend_api_key) return res.status(500).json({ error: 'Resend API key not configured' });
    const { to, subject, html, text, from, replyTo } = req.body;
    if (!to || !subject) return res.status(400).json({ error: 'Missing: to, subject' });
    if (!html && !text) return res.status(400).json({ error: 'html or text required' });
    const fromAddr = from || `${settings.resend_from_name || 'VIBECODING'} <${settings.resend_from_email}>`;
    const emailData = { from: fromAddr, to: Array.isArray(to) ? to : [to], subject };
    if (html) emailData.html = html;
    if (text) emailData.text = text;
    if (replyTo) emailData.reply_to = replyTo;
    else if (settings.resend_reply_to) emailData.reply_to = settings.resend_reply_to;
    const result = await sendResend(settings.resend_api_key, emailData);
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. CREATE USER
app.post('/create-user', async (req, res) => {
  try {
    const { email, password, full_name, role } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const supabase = getAdmin();
    const { data: newUser, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: full_name || '' }
    });
    if (error) throw new Error(error.message);
    try {
      await supabase.from('profiles').insert({
        id: newUser.user.id,
        email,
        full_name: full_name || '',
        role: role || 'user',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    } catch (e) { console.error('Profile create error:', e.message); }
    res.json({ success: true, userId: newUser.user.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 4. DELETE USER
app.post('/delete-user', async (req, res) => {
  try {
    const { userId, email } = req.body;
    if (!userId && !email) return res.status(400).json({ error: 'userId or email required' });
    const supabase = getAdmin();
    let targetId = userId;
    if (!targetId && email) {
      const { data: { users }, error } = await supabase.auth.admin.listUsers();
      if (error) throw new Error(error.message);
      const found = users.find(u => u.email === email);
      if (!found) return res.status(404).json({ error: 'User not found' });
      targetId = found.id;
    }
    const { error } = await supabase.auth.admin.deleteUser(targetId);
    if (error) throw new Error(error.message);
    res.json({ success: true, message: `User ${email || targetId} deleted` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 5. GENERATE QUOTE
app.post('/generate-quote', async (req, res) => {
  try {
    const { prompt, teacher } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt required' });
    const supabase = getAdmin();
    const { data, error } = await supabase.from('openrouter_settings').select('*').limit(1).single();
    if (error || !data?.api_key) return res.json({ error: 'OpenRouter not configured', quote: null });
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${data.api_key}`, 'HTTP-Referer': 'https://vibecoding.by', 'X-Title': 'Vibecoding' },
      body: JSON.stringify({ model: data.model || 'openai/gpt-3.5-turbo', messages: [{ role: 'user', content: prompt }] })
    });
    if (!response.ok) return res.json({ error: 'OpenRouter request failed', quote: null });
    const result = await response.json();
    res.json({ quote: result.choices?.[0]?.message?.content || null, teacher });
  } catch (e) { res.status(500).json({ error: 'Internal server error', quote: null }); }
});

// 6. SEND TEST EMAIL
app.post('/send-test-email', async (req, res) => {
  try {
    const { testEmail } = req.body;
    if (!testEmail) return res.status(400).json({ error: 'Test email required' });
    const settings = await getSettings(['resend_api_key', 'resend_from_email', 'resend_from_name', 'resend_reply_to']);
    if (!settings.resend_api_key || !settings.resend_from_email) return res.status(400).json({ error: 'Resend not configured' });
    const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' });
    const result = await sendResend(settings.resend_api_key, {
      from: `${settings.resend_from_name || 'VIBECODING'} <${settings.resend_from_email}>`,
      to: [testEmail], subject: '+++ VIBECODING Test Email +++',
      html: `<h1 style="color:#00fff9">VIBECODING Test Email</h1><p>Timestamp: ${timestamp}</p><p>Email service is working.</p>`
    });
    await logEmail({ resend_email_id: result.id, recipient_email: testEmail, subject: 'Test Email', template_type: 'test', status: 'sent' });
    res.json({ success: true, message: `Test email sent to ${testEmail}`, emailId: result.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 7. SEND HOMEWORK NOTIFICATION
app.post('/send-homework-notification', async (req, res) => {
  try {
    const { studentEmail, studentName, lessonTitle, courseTitle, status, feedback } = req.body;
    if (!studentEmail || !lessonTitle || !status) return res.status(400).json({ error: 'Missing fields' });
    const settings = await getSettings(['resend_api_key', 'resend_from_email', 'resend_from_name']);
    if (!settings.resend_api_key || !settings.resend_from_email) return res.status(500).json({ error: 'Email not configured' });
    const statusText = status === 'approved' ? 'принято' : 'требует доработки';
    const statusEmoji = status === 'approved' ? '✅' : '📝';
    const statusColor = status === 'approved' ? '#39ff14' : '#ff006e';
    const subject = `${statusEmoji} Домашнее задание ${statusText} - ${lessonTitle}`;
    const html = `<div style="font-family:sans-serif;background:#0a0a0f;color:#fff;padding:40px 20px;"><div style="max-width:600px;margin:0 auto;"><h1 style="color:#00fff9">VibeCoding</h1><p>Привет, ${studentName || 'студент'}!</p><div style="padding:10px 20px;background:${status==='approved'?'rgba(57,255,20,0.2)':'rgba(255,0,110,0.2)'};border:1px solid ${statusColor};border-radius:8px;color:${statusColor};font-weight:bold;display:inline-block;margin:15px 0;">${statusEmoji} Домашнее задание ${statusText}</div><div style="background:rgba(0,255,249,0.05);padding:20px;border-radius:8px;margin:15px 0;"><p style="color:#888;font-size:12px;margin:0">Курс:</p><p style="color:#00fff9;margin:4px 0 12px">${courseTitle||'Курс'}</p><p style="color:#888;font-size:12px;margin:0">Урок:</p><p style="color:#00fff9;margin:4px 0">${lessonTitle}</p></div>${feedback?`<div style="border-left:3px solid ${statusColor};padding:15px 20px;background:rgba(0,0,0,0.3);margin:15px 0;"><p style="color:#888;font-size:12px;margin:0 0 8px">Комментарий:</p><p style="margin:0">${feedback}</p></div>`:''}<div style="text-align:center;margin:25px 0"><a href="https://vibecoding.by/student/dashboard" style="display:inline-block;padding:15px 30px;background:linear-gradient(135deg,#00fff9,#00b8b8);color:#0a0a0f;text-decoration:none;border-radius:8px;font-weight:bold;">Перейти к обучению</a></div></div></div>`;
    const result = await sendResend(settings.resend_api_key, { from: `${settings.resend_from_name||'VibeCoding'} <${settings.resend_from_email}>`, to: [studentEmail], subject, html });
    await logEmail({ resend_email_id: result.id, recipient_email: studentEmail, subject, template_type: 'homework_notification', status: 'sent', metadata: { lessonTitle, courseTitle, homeworkStatus: status } });
    res.json({ success: true, emailId: result.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 8. SEND VERIFICATION EMAIL
app.post('/send-verification-email', async (req, res) => {
  try {
    const { email, fullName, siteUrl } = req.body;
    if (!email || !siteUrl) return res.status(400).json({ error: 'Email and siteUrl required' });
    const supabase = getAdmin();
    const { data: existing } = await supabase.from('profiles').select('id').eq('email', email).limit(1);
    if (existing && existing.length > 0) return res.status(400).json({ error: 'user_already_exists', message: 'Already registered' });
    const settings = await getSettings(['resend_api_key', 'resend_from_email', 'resend_from_name']);
    if (!settings.resend_api_key || !settings.resend_from_email) return res.status(500).json({ error: 'Email not configured' });
    await supabase.from('auth_tokens').delete().eq('email', email).eq('token_type', 'email_verification');
    const token = crypto.randomBytes(32).toString('hex');
    await supabase.from('auth_tokens').insert({
      id: crypto.randomUUID(),
      email, token, token_type: 'email_verification',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      created_at: new Date().toISOString()
    });
    const verificationUrl = `${siteUrl}/student/verify?token=${token}&email=${encodeURIComponent(email)}&name=${encodeURIComponent(fullName || '')}`;
    const html = `<div style="font-family:sans-serif;background:#0a0a0f;color:#fff;padding:40px 20px;"><div style="max-width:600px;margin:0 auto;background:linear-gradient(135deg,rgba(0,255,249,0.1),rgba(255,0,110,0.05));border:1px solid rgba(0,255,249,0.3);border-radius:12px;padding:40px;"><h1 style="color:#00fff9">VIBECODING</h1><p style="color:#ccc">Привет${fullName?', '+fullName:''}!</p><p style="color:#ccc">Подтвердите ваш email:</p><div style="text-align:center;margin:25px 0"><a href="${verificationUrl}" style="display:inline-block;background:linear-gradient(135deg,#00fff9,#00b8b0);color:#000;text-decoration:none;padding:16px 32px;border-radius:8px;font-weight:bold;">ПОДТВЕРДИТЬ EMAIL</a></div><p style="color:#ff6b6b;font-size:14px">Ссылка действительна 24 часа.</p></div></div>`;
    const result = await sendResend(settings.resend_api_key, { from: `${settings.resend_from_name||'VIBECODING'} <${settings.resend_from_email}>`, to: [email], subject: 'VIBECODING - Подтверждение email', html });
    await logEmail({ resend_email_id: result.id, recipient_email: email, subject: 'Подтверждение email', template_type: 'verification', status: 'sent', metadata: { fullName } });
    res.json({ success: true, message: 'Verification email sent' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 9. RESEND WEBHOOK
app.post('/resend-webhook', async (req, res) => {
  try {
    const payload = req.body;
    const eventType = payload.type;
    const emailId = payload.data?.email_id;
    if (!emailId) return res.json({ success: true, message: 'No email_id' });
    const supabase = getAdmin();
    const updates = { updated_at: new Date().toISOString() };
    switch (eventType) {
      case 'email.sent': updates.status = 'sent'; break;
      case 'email.delivered': updates.status = 'delivered'; break;
      case 'email.opened': updates.status = 'opened'; break;
      case 'email.clicked': updates.status = 'clicked'; break;
      case 'email.bounced': updates.status = 'bounced'; updates.error_message = payload.data?.bounce?.message || 'Bounced'; break;
      case 'email.complained': updates.status = 'complained'; break;
      default: return res.json({ success: true });
    }
    await supabase.from('email_logs').update(updates).eq('resend_email_id', emailId);
    res.json({ success: true, event: eventType });
  } catch (e) { res.status(500).json({ error: 'Webhook failed' }); }
});

// 10. INBOUND EMAIL
app.post('/inbound-email', async (req, res) => {
  try {
    const payload = req.body;
    const supabase = getAdmin();
    if (payload.type !== 'email.received') return res.json({ success: true, message: 'Event type not handled' });
    const emailData = payload.data;
    let htmlContent = emailData.html || null;
    let textContent = emailData.text || null;
    if (!htmlContent && !textContent && emailData.email_id) {
      const settings = await getSettings(['resend_api_key']);
      if (settings.resend_api_key) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            if (attempt > 1) await new Promise(r => setTimeout(r, 2000));
            const resp = await fetch(`https://api.resend.com/emails/receiving/${emailData.email_id}`, {
              headers: { 'Authorization': `Bearer ${settings.resend_api_key}`, 'Content-Type': 'application/json' }
            });
            if (resp.ok) {
              const content = await resp.json();
              htmlContent = content.html || content.body || null;
              textContent = content.text || content.plain_text || null;
              if (htmlContent || textContent) break;
            }
          } catch (e) { console.error(`inbound-email fetch attempt ${attempt}:`, e.message); }
        }
      }
    }
    const fromMatch = emailData.from.match(/^(.+?)\s*<(.+?)>$/) || [null, null, emailData.from];
    const fromName = fromMatch[1]?.trim() || '';
    const fromEmail = fromMatch[2] || emailData.from;
    await supabase.from('inbox').insert({
      message_id: emailData.email_id || '',
      from_email: fromEmail,
      from_name: fromName,
      to_email: emailData.to?.[0] || '',
      subject: emailData.subject || '(No subject)',
      text_content: (textContent || '').substring(0, 5000),
      html_content: (htmlContent || '').substring(0, 5000),
      is_read: false,
      is_archived: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    console.log(`Inbound email stored: ${emailData.email_id} from ${fromEmail}`);
    res.json({ success: true, message: 'Email received and stored', email_id: emailData.email_id });
  } catch (e) {
    console.error('inbound-email error:', e);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(3333, '0.0.0.0', () => console.log('VibeCoding API on port 3333'));
