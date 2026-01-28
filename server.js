require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Helper to get base URL (works for both local and production)
function getBaseUrl(req) {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL;
  }
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${protocol}://${host}`;
}

// Store tokens in memory (in production, use a database)
let stravaTokens = {
  access_token: process.env.STRAVA_ACCESS_TOKEN,
  refresh_token: process.env.STRAVA_REFRESH_TOKEN
};

let ouraTokens = {
  access_token: null,
  refresh_token: null
};

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
  const baseUrl = getBaseUrl(req);

  console.log('Oura callback received. Code:', code ? 'present' : 'missing', 'Error:', ouraError || 'none');
  console.log('Base URL detected:', baseUrl);

  if (ouraError) {
    console.error('Oura authorization denied:', ouraError);
    return res.redirect('/?oura=error&reason=' + encodeURIComponent(ouraError));
  }

  if (!code) {
    console.error('No authorization code received from Oura');
    return res.redirect('/?oura=error&reason=no_code');
  }

  try {
    const redirectUri = `${baseUrl}/callback/oura`;
    console.log('Token exchange with redirect_uri:', redirectUri);

    // Oura requires form-urlencoded data
    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('client_id', process.env.OURA_CLIENT_ID);
    params.append('client_secret', process.env.OURA_CLIENT_SECRET);
    params.append('redirect_uri', redirectUri);

    const response = await axios.post('https://api.ouraring.com/oauth/token', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    ouraTokens.access_token = response.data.access_token;
    ouraTokens.refresh_token = response.data.refresh_token;
    console.log('Oura connected successfully!');
    res.redirect('/?oura=connected');
  } catch (error) {
    const errorMsg = error.response?.data?.detail || error.response?.data?.error || error.message;
    console.error('Oura OAuth error:', JSON.stringify(error.response?.data || error.message));
    res.redirect('/?oura=error&reason=' + encodeURIComponent(errorMsg));
  }
});

// Get Oura auth URL
app.get('/api/oura/auth-url', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const authUrl = `https://cloud.ouraring.com/oauth/authorize?client_id=${process.env.OURA_CLIENT_ID}&redirect_uri=${baseUrl}/callback/oura&response_type=code&scope=daily%20heartrate%20personal%20session%20workout`;
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

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🏃 Health Dashboard running at http://localhost:${PORT}`);
  console.log('\n📊 Open your browser to view your unified health data!\n');
});
