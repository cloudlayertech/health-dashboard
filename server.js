require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize Anthropic client
const anthropic = new Anthropic();

// Helper to get base URL (works for both local and production)
function getBaseUrl(req) {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL;
  }
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${protocol}://${host}`;
}

// Store tokens in memory, initialized from environment variables
let stravaTokens = {
  access_token: process.env.STRAVA_ACCESS_TOKEN || null,
  refresh_token: process.env.STRAVA_REFRESH_TOKEN || null
};

let ouraTokens = {
  access_token: process.env.OURA_ACCESS_TOKEN || null,
  refresh_token: process.env.OURA_REFRESH_TOKEN || null
};

// Log token status on startup
console.log('Token status on startup:');
console.log('  Strava:', stravaTokens.access_token ? 'loaded from env' : 'not set');
console.log('  Oura:', ouraTokens.access_token ? 'loaded from env' : 'not set');

// ============== STRAVA API ==============

// Get Strava auth URL - need to re-authorize with activity:read scope
app.get('/api/strava/auth-url', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const authUrl = `https://www.strava.com/oauth/authorize?client_id=${process.env.STRAVA_CLIENT_ID}&redirect_uri=${baseUrl}/callback/strava&response_type=code&scope=read,activity:read_all,profile:read_all`;
  res.json({ url: authUrl });
});

// Strava OAuth callback
app.get('/callback/strava', async (req, res) => {
  const { code } = req.query;
  try {
    const response = await axios.post('https://www.strava.com/oauth/token', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code: code,
      grant_type: 'authorization_code'
    });
    stravaTokens.access_token = response.data.access_token;
    stravaTokens.refresh_token = response.data.refresh_token;
    console.log('Strava connected! Scopes:', response.data.scope);
    console.log('\n=== STRAVA TOKENS (add these to Render environment variables) ===');
    console.log('STRAVA_ACCESS_TOKEN=' + response.data.access_token);
    console.log('STRAVA_REFRESH_TOKEN=' + response.data.refresh_token);
    console.log('===============================================================\n');
    res.redirect('/?strava=connected');
  } catch (error) {
    console.error('Strava OAuth error:', error.response?.data || error.message);
    res.redirect('/?strava=error');
  }
});

// Check Strava connection status
app.get('/api/strava/status', (req, res) => {
  res.json({ connected: !!stravaTokens.access_token });
});

// Refresh Strava token if needed
async function refreshStravaToken() {
  try {
    const response = await axios.post('https://www.strava.com/oauth/token', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: stravaTokens.refresh_token,
      grant_type: 'refresh_token'
    });
    stravaTokens.access_token = response.data.access_token;
    stravaTokens.refresh_token = response.data.refresh_token;
    return stravaTokens.access_token;
  } catch (error) {
    console.error('Error refreshing Strava token:', error.message);
    throw error;
  }
}

// Get Strava activities
app.get('/api/strava/activities', async (req, res) => {
  if (!stravaTokens.access_token) {
    return res.status(401).json({ error: 'Strava not connected', needsAuth: true });
  }
  try {
    const response = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
      headers: { Authorization: `Bearer ${stravaTokens.access_token}` },
      params: { per_page: 30 }
    });
    res.json(response.data);
  } catch (error) {
    if (error.response?.status === 401) {
      // Token expired or missing scope, need re-auth
      stravaTokens.access_token = null;
      return res.status(401).json({ error: 'Strava authorization required', needsAuth: true });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Get Strava athlete stats
app.get('/api/strava/athlete', async (req, res) => {
  if (!stravaTokens.access_token) {
    return res.status(401).json({ error: 'Strava not connected', needsAuth: true });
  }
  try {
    const response = await axios.get('https://www.strava.com/api/v3/athlete', {
      headers: { Authorization: `Bearer ${stravaTokens.access_token}` }
    });
    res.json(response.data);
  } catch (error) {
    if (error.response?.status === 401) {
      stravaTokens.access_token = null;
      return res.status(401).json({ error: 'Strava authorization required', needsAuth: true });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// ============== OURA API ==============

// Oura OAuth callback
app.get('/callback/oura', async (req, res) => {
  const { code, error: ouraError } = req.query;

  // Use hardcoded URL for Render deployment
  const OURA_REDIRECT_URI = process.env.OURA_REDIRECT_URI || 'https://health-dashboard-1-73zv.onrender.com/callback/oura';

  console.log('Oura callback received. Code:', code ? 'present' : 'missing', 'Error:', ouraError || 'none');

  if (ouraError) {
    console.error('Oura authorization denied:', ouraError);
    return res.redirect('/?oura=error&reason=' + encodeURIComponent(ouraError));
  }

  if (!code) {
    console.error('No authorization code received from Oura');
    return res.redirect('/?oura=error&reason=no_code');
  }

  try {
    console.log('Token exchange with redirect_uri:', OURA_REDIRECT_URI);

    // Oura requires form-urlencoded data
    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('client_id', process.env.OURA_CLIENT_ID);
    params.append('client_secret', process.env.OURA_CLIENT_SECRET);
    params.append('redirect_uri', OURA_REDIRECT_URI);

    const response = await axios.post('https://api.ouraring.com/oauth/token', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    ouraTokens.access_token = response.data.access_token;
    ouraTokens.refresh_token = response.data.refresh_token;
    console.log('Oura connected successfully!');
    console.log('\n=== OURA TOKENS (add these to Render environment variables) ===');
    console.log('OURA_ACCESS_TOKEN=' + response.data.access_token);
    console.log('OURA_REFRESH_TOKEN=' + response.data.refresh_token);
    console.log('==============================================================\n');
    res.redirect('/?oura=connected');
  } catch (error) {
    const errorMsg = error.response?.data?.detail || error.response?.data?.error || error.message;
    console.error('Oura OAuth error:', JSON.stringify(error.response?.data || error.message));
    res.redirect('/?oura=error&reason=' + encodeURIComponent(errorMsg));
  }
});

// Get Oura auth URL
app.get('/api/oura/auth-url', (req, res) => {
  // Use hardcoded URL for Render deployment
  const OURA_REDIRECT_URI = process.env.OURA_REDIRECT_URI || 'https://health-dashboard-1-73zv.onrender.com/callback/oura';
  // Scopes should use + as separator per Oura docs
  const authUrl = `https://cloud.ouraring.com/oauth/authorize?client_id=${process.env.OURA_CLIENT_ID}&redirect_uri=${encodeURIComponent(OURA_REDIRECT_URI)}&response_type=code&scope=daily+heartrate+personal+session+workout`;
  res.json({ url: authUrl });
});

// Check Oura connection status
app.get('/api/oura/status', (req, res) => {
  res.json({ connected: !!ouraTokens.access_token });
});

// Get Oura daily readiness
app.get('/api/oura/readiness', async (req, res) => {
  if (!ouraTokens.access_token) {
    return res.status(401).json({ error: 'Oura not connected' });
  }
  try {
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const response = await axios.get(`https://api.ouraring.com/v2/usercollection/daily_readiness`, {
      headers: { Authorization: `Bearer ${ouraTokens.access_token}` },
      params: { start_date: startDate, end_date: endDate }
    });
    res.json(response.data);
  } catch (error) {
    console.error('Oura readiness error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get Oura sleep data
app.get('/api/oura/sleep', async (req, res) => {
  if (!ouraTokens.access_token) {
    return res.status(401).json({ error: 'Oura not connected' });
  }
  try {
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const response = await axios.get(`https://api.ouraring.com/v2/usercollection/daily_sleep`, {
      headers: { Authorization: `Bearer ${ouraTokens.access_token}` },
      params: { start_date: startDate, end_date: endDate }
    });
    res.json(response.data);
  } catch (error) {
    console.error('Oura sleep error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get Oura activity data
app.get('/api/oura/activity', async (req, res) => {
  if (!ouraTokens.access_token) {
    return res.status(401).json({ error: 'Oura not connected' });
  }
  try {
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const response = await axios.get(`https://api.ouraring.com/v2/usercollection/daily_activity`, {
      headers: { Authorization: `Bearer ${ouraTokens.access_token}` },
      params: { start_date: startDate, end_date: endDate }
    });
    res.json(response.data);
  } catch (error) {
    console.error('Oura activity error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get Oura heart rate data
app.get('/api/oura/heartrate', async (req, res) => {
  if (!ouraTokens.access_token) {
    return res.status(401).json({ error: 'Oura not connected' });
  }
  try {
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const response = await axios.get(`https://api.ouraring.com/v2/usercollection/heartrate`, {
      headers: { Authorization: `Bearer ${ouraTokens.access_token}` },
      params: { start_date: startDate, end_date: endDate }
    });
    res.json(response.data);
  } catch (error) {
    console.error('Oura heartrate error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get Oura sleep details (includes HRV, sleep stages)
app.get('/api/oura/sleep-details', async (req, res) => {
  if (!ouraTokens.access_token) {
    return res.status(401).json({ error: 'Oura not connected' });
  }
  try {
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const response = await axios.get(`https://api.ouraring.com/v2/usercollection/sleep`, {
      headers: { Authorization: `Bearer ${ouraTokens.access_token}` },
      params: { start_date: startDate, end_date: endDate }
    });
    res.json(response.data);
  } catch (error) {
    console.error('Oura sleep details error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============== AI FEATURES ==============

// Helper to format health data for AI context
function formatHealthContext(ouraData, stravaData) {
  let context = '';

  if (ouraData.sleep && ouraData.sleep.length) {
    const recentSleep = ouraData.sleep.slice(-7);
    context += `\n## Sleep Data (Last 7 days):\n`;
    recentSleep.forEach(s => {
      context += `- ${s.day}: Score ${s.score}\n`;
    });
  }

  if (ouraData.readiness && ouraData.readiness.length) {
    const recentReadiness = ouraData.readiness.slice(-7);
    context += `\n## Readiness Data (Last 7 days):\n`;
    recentReadiness.forEach(r => {
      context += `- ${r.day}: Score ${r.score}`;
      if (r.contributors) {
        context += ` (Sleep: ${r.contributors.previous_night || 'N/A'}, Recovery: ${r.contributors.recovery_index || 'N/A'})`;
      }
      context += '\n';
    });
  }

  if (ouraData.sleepDetails && ouraData.sleepDetails.length) {
    const recent = ouraData.sleepDetails.slice(-7);
    context += `\n## Sleep Details (Last 7 days):\n`;
    recent.forEach(s => {
      context += `- ${s.day}: HRV ${s.average_hrv || 'N/A'}ms, Resting HR ${s.lowest_heart_rate || 'N/A'}bpm, `;
      context += `Deep ${Math.round((s.deep_sleep_duration || 0) / 60)}min, REM ${Math.round((s.rem_sleep_duration || 0) / 60)}min, `;
      context += `Efficiency ${s.efficiency || 'N/A'}%\n`;
    });
  }

  if (ouraData.activity && ouraData.activity.length) {
    const recentActivity = ouraData.activity.slice(-7);
    context += `\n## Daily Activity (Last 7 days):\n`;
    recentActivity.forEach(a => {
      context += `- ${a.day}: Steps ${a.steps}, Active Cal ${a.active_calories}, `;
      context += `High Activity ${Math.round((a.high_activity_time || 0) / 60)}min\n`;
    });
  }

  if (stravaData.activities && stravaData.activities.length) {
    const recentWorkouts = stravaData.activities.slice(0, 10);
    context += `\n## Recent Workouts (Strava):\n`;
    recentWorkouts.forEach(w => {
      const date = new Date(w.start_date_local).toISOString().split('T')[0];
      context += `- ${date}: ${w.type} - ${w.name}, ${(w.distance/1000).toFixed(1)}km, `;
      context += `${Math.round(w.moving_time/60)}min`;
      if (w.average_heartrate) context += `, Avg HR ${Math.round(w.average_heartrate)}bpm`;
      context += '\n';
    });
  }

  return context;
}

// AI Chat endpoint
app.post('/api/ai/chat', async (req, res) => {
  const { message, healthData } = req.body;

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'AI not configured - add ANTHROPIC_API_KEY to environment' });
  }

  try {
    const healthContext = formatHealthContext(
      healthData?.oura || {},
      healthData?.strava || {}
    );

    const systemPrompt = `You are a friendly health and fitness AI assistant analyzing data from Oura Ring and Strava.
You have access to the user's recent health metrics including sleep scores, HRV, readiness, activity levels, and workout data.
Provide personalized, actionable insights based on their data. Be concise but helpful.
Use the health data provided to give specific, data-driven recommendations.
If asked about trends, analyze the patterns in the data.
Always be encouraging while being honest about areas for improvement.

Current Health Data:
${healthContext}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: message }]
    });

    res.json({ response: response.content[0].text });
  } catch (error) {
    console.error('AI chat error:', error.message);
    res.status(500).json({ error: 'AI request failed: ' + error.message });
  }
});

// AI Daily Summary endpoint
app.post('/api/ai/daily-summary', async (req, res) => {
  const { healthData } = req.body;

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'AI not configured - add ANTHROPIC_API_KEY to environment' });
  }

  try {
    const healthContext = formatHealthContext(
      healthData?.oura || {},
      healthData?.strava || {}
    );

    const prompt = `Based on the health data below, provide a brief daily briefing (3-4 sentences) covering:
1. How well recovered the user is today based on readiness and HRV
2. Whether they should train hard, moderate, or rest
3. One specific actionable tip based on their recent patterns

Health Data:
${healthContext}

Provide the briefing in a friendly, motivating tone. Start with a greeting based on their readiness level.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    });

    res.json({ summary: response.content[0].text });
  } catch (error) {
    console.error('AI summary error:', error.message);
    res.status(500).json({ error: 'AI request failed: ' + error.message });
  }
});

// AI Trend Analysis endpoint
app.post('/api/ai/trends', async (req, res) => {
  const { healthData } = req.body;

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'AI not configured - add ANTHROPIC_API_KEY to environment' });
  }

  try {
    const healthContext = formatHealthContext(
      healthData?.oura || {},
      healthData?.strava || {}
    );

    const prompt = `Analyze the health and fitness data below and identify key trends and patterns. Provide insights in these categories:

1. **Sleep Patterns**: What trends do you see in sleep quality? Any concerning patterns?
2. **Recovery Trends**: How is HRV trending? Is recovery improving or declining?
3. **Training Load**: Is the workout volume appropriate given recovery metrics?
4. **Correlations**: What factors seem to affect their performance positively or negatively?
5. **Recommendations**: 2-3 specific actions they should take based on these patterns.

Health Data:
${healthContext}

Format your response with clear headers and bullet points. Be specific and reference actual numbers from the data.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });

    res.json({ analysis: response.content[0].text });
  } catch (error) {
    console.error('AI trends error:', error.message);
    res.status(500).json({ error: 'AI request failed: ' + error.message });
  }
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🏃 Health Dashboard running at http://localhost:${PORT}`);
  console.log('\n📊 Open your browser to view your unified health data!\n');
});
