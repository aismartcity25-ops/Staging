require('dotenv').config();

const twilioConfig = {
  accountSid: process.env.TWILIO_ACCOUNT_SID,
  authToken: process.env.TWILIO_AUTH_TOKEN,
  whatsappNumber: process.env.TWILIO_WHATSAPP_NUMBER,
  phoneNumber: process.env.TWILIO_PHONE_NUMBER,
  phoneNumberSid: process.env.TWILIO_PHONE_NUMBER_SID,
  emailSender: process.env.TWILIO_EMAIL_SENDER,
  webhookUrl: process.env.TWILIO_WEBHOOK_URL || '/twilio/webhook'
};

module.exports = twilioConfig;
