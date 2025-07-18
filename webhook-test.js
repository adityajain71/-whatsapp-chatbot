import express from 'express';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Simple home route
app.get('/', (req, res) => {
  res.send('Webhook test server is running');
});

// Webhook verification route
app.get('/webhook', (req, res) => {
  console.log('Received webhook verification request');
  
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  console.log(`Mode: ${mode}`);
  console.log(`Token: ${token}`);
  console.log(`Challenge: ${challenge}`);
  console.log(`Expected token: ${process.env.VERIFY_TOKEN}`);
  
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('WEBHOOK_VERIFIED');
    return res.status(200).send(challenge);
  }
  
  console.log('WEBHOOK_VERIFICATION_FAILED');
  return res.sendStatus(403);
});

// Start server
app.listen(port, () => {
  console.log(`Test server running on port ${port}`);
  console.log(`Webhook URL: ${process.env.BASE_URL}/webhook`);
  console.log(`Verify token: ${process.env.VERIFY_TOKEN}`);
});