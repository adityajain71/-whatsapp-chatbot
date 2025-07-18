import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import axios from "axios";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import nodemailer from 'nodemailer';
import Razorpay from 'razorpay';

// Configure __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize environment and app
dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

// Initialize Razorpay
let razorpay;
try {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
  console.log('Razorpay initialized successfully');
} catch (error) {
  console.warn('Failed to initialize Razorpay:', error.message);
  console.warn('Payment verification will use basic validation only');
}

// Create a simple email transport using Gmail
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_APP_PASSWORD
  }
});

console.log('Email configuration loaded');

// Oil Menu Configuration
const oilMenu = [
  { id: 1, name: "Sunflower Oil", price: 120 },
  { id: 2, name: "Mustard Oil", price: 140 },
  { id: 3, name: "Groundnut Oil", price: 160 },
];

// In-memory order tracking
const userOrders = {};

// Middleware setup
app.use('/static', express.static(path.join(__dirname, 'static')));
app.use(bodyParser.json());

// ======================
// HELPER FUNCTIONS
// ======================

async function notifyPaymentScreenshot(paymentInfo) {
  try {
    // Create email HTML content
    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #4CAF50; color: white; padding: 10px; text-align: center;">
          <h2>💳 Payment Screenshot Received</h2>
        </div>
        
        <p>Dear Admin,</p>
        <p>A payment screenshot has been received for verification.</p>
        
        <div style="margin: 20px 0; padding: 15px; background-color: #f9f9f9;">
          <h3>Payment Information:</h3>
          <p><strong>Order ID:</strong> ${paymentInfo.orderId}</p>
          <p><strong>Customer Phone:</strong> ${paymentInfo.phone}</p>
          <p><strong>Amount:</strong> ₹${paymentInfo.total}</p>
          <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
          
          <h3>Payment Screenshot:</h3>
          <p>The payment screenshot is attached to this email.</p>
        </div>
        
        <p>Please verify this payment and process the order accordingly.</p>
        
        <div style="background-color: #f1f1f1; padding: 10px; text-align: center; font-size: 12px;">
          <p>This is an automated message from OilFacts Order System.</p>
        </div>
      </div>
    `;

    // Download the screenshot image
    const imageBuffer = await downloadWhatsAppMedia(paymentInfo.mediaId);
    
    // Send email with attachment using nodemailer
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: process.env.SUPPLIER_EMAIL,
      subject: `💳 Payment Screenshot for Order #${paymentInfo.orderId} - ₹${paymentInfo.total}`,
      html: htmlContent,
      attachments: [
        {
          filename: `payment-screenshot-${paymentInfo.orderId}.jpg`,
          content: imageBuffer
        }
      ]
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`Payment screenshot notification sent for order ${paymentInfo.orderId}, messageId: ${info.messageId}`);
  } catch (error) {
    console.error("Failed to send payment screenshot notification:", error.message);
  }
}

async function sendWhatsAppMessage(phone, message) {
  try {
    console.log(`Sending to ${phone}: ${message}`); // Log outgoing messages
    
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: phone,
        type: "text",
        text: { 
          body: message
            .replace(/<b>/g, '*').replace(/<\/b>/g, '*') // Convert HTML bold to WhatsApp formatting
            .replace(/<i>/g, '_').replace(/<\/i>/g, '_') // Convert HTML italic to WhatsApp formatting
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
    return response.data;
  } catch (error) {
    // Check if token expired
    if (error.response?.status === 401 && 
        error.response?.data?.error?.code === 190 && 
        error.response?.data?.error?.error_subcode === 463) {
      console.error("WhatsApp API token has expired. Please update your ACCESS_TOKEN in .env file.");
      // Continue execution without throwing to prevent app crash
      return { error: "TOKEN_EXPIRED", message: "WhatsApp API token expired" };
    }
    
    console.error("Failed to send WhatsApp message:", error.response?.data || error.message);
    // Don't throw the error to prevent app crash
    return { error: "SEND_FAILED", message: error.message };
  }
}

async function generateQR(orderId, amount) {
  const upiId = process.env.UPI_ID || "default@upi";
  // Format amount to ensure it's a valid number with 2 decimal places
  const formattedAmount = parseFloat(amount).toFixed(2);
  const upiUrl = `upi://pay?pa=${upiId}&pn=OilFacts&am=${formattedAmount}&cu=INR&tn=Order%20${orderId}`;
  
  console.log(`Generating QR code for amount: ₹${formattedAmount}`);
  
  const qrPath = path.join(__dirname, 'static', `qr_${orderId}.png`);
  await QRCode.toFile(qrPath, upiUrl);
  
  // Fix: Remove backslash from BASE_URL if present
  const baseUrl = (process.env.BASE_URL || `http://localhost:${port}`).replace(/^\\/, '');
  return `${baseUrl}/static/qr_${orderId}.png`;
}

async function downloadWhatsAppMedia(mediaId) {
  try {
    // Step 1: Get media URL from WhatsApp API
    const mediaResponse = await axios.get(
      `https://graph.facebook.com/v18.0/${mediaId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.ACCESS_TOKEN}`
        }
      }
    );
    
    if (!mediaResponse.data || !mediaResponse.data.url) {
      throw new Error('Failed to get media URL from WhatsApp API');
    }
    
    // Step 2: Download the media file
    const mediaUrl = mediaResponse.data.url;
    const mediaDownloadResponse = await axios.get(mediaUrl, {
      headers: {
        Authorization: `Bearer ${process.env.ACCESS_TOKEN}`
      },
      responseType: 'arraybuffer'
    });
    
    // Return the media as a buffer
    return Buffer.from(mediaDownloadResponse.data);
  } catch (error) {
    console.error('Error downloading WhatsApp media:', error.message);
    throw error;
  }
}

async function notifySupplier(orderDetails) {
  try {
    // Generate HTML for order items
    const itemsHtml = orderDetails.items.map(item => 
      `<li>${item.name} - ${item.qty}L × ₹${item.price} = ₹${item.subtotal}</li>`
    ).join('');
    
    // Create email HTML content
    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #4CAF50; color: white; padding: 10px; text-align: center;">
          <h2>🛒 Order Confirmation #${orderDetails.orderId}</h2>
        </div>
        
        <p>Dear Supplier,</p>
        <p>A new order has been placed and payment has been received.</p>
        
        <div style="margin: 20px 0; padding: 15px; background-color: #f9f9f9;">
          <h3>Order Information:</h3>
          <p><strong>Order ID:</strong> ${orderDetails.orderId}</p>
          <p><strong>Customer Phone:</strong> ${orderDetails.phone}</p>
          <p><strong>Order Date:</strong> ${new Date().toLocaleString()}</p>
          <p><strong>Payment Reference:</strong> ${orderDetails.paymentReference || 'Not provided'}</p>
          <p><strong>Payment Status:</strong> ${orderDetails.paymentStatus || 'Unknown'}</p>
          ${orderDetails.needsVerification ? '<p style="color: red; font-weight: bold;">⚠️ PAYMENT NEEDS VERIFICATION</p>' : ''}
          
          <h3>Delivery Address:</h3>
          <p>${orderDetails.address}</p>
          
          <h3>Order Items:</h3>
          <ul>
            ${itemsHtml}
          </ul>
          
          <div style="font-size: 18px; font-weight: bold; margin-top: 15px; text-align: right;">
            <p>Total: ₹${orderDetails.total}</p>
          </div>
        </div>
        
        <p>Please process this order as soon as possible.</p>
        
        <div style="background-color: #f1f1f1; padding: 10px; text-align: center; font-size: 12px;">
          <p>This is an automated message from OilFacts Order System.</p>
        </div>
      </div>
    `;

    // Send email using nodemailer
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: process.env.SUPPLIER_EMAIL,
      subject: `🛒 New Order #${orderDetails.orderId} - ₹${orderDetails.total}`,
      html: htmlContent
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`Email sent to supplier for order ${orderDetails.orderId}, messageId: ${info.messageId}`);
  } catch (error) {
    console.error("Failed to send email:", error.message);
  }
}

// ======================
// ORDER PROCESSING FLOW
// ======================

async function handleMenuRequest(phone) {
  const menuText = oilMenu.map(item => 
    `${item.id}. ${item.name} - ₹${item.price}/L`
  ).join('\n');

  userOrders[phone] = {
    step: "select_items",
    items: []
  };

  await sendWhatsAppMessage(phone,
    "🏪 *OilFacts Menu:*\n\n" +
    menuText +
    "\n\nReply with item numbers (e.g. *1,3*)"
  );
}

async function handleItemSelection(phone, message) {
  const selectedIds = message.split(',')
    .map(id => parseInt(id.trim()))
    .filter(id => !isNaN(id) && oilMenu.some(item => item.id === id));

  if (selectedIds.length === 0) {
    await sendWhatsAppMessage(phone, 
      "❌ Invalid selection. Please reply with numbers like *1,3*"
    );
    return;
  }

  userOrders[phone] = {
    step: "select_quantities",
    items: oilMenu.filter(item => selectedIds.includes(item.id)).map(item => ({
      ...item,
      qty: null
    })),
    currentItemIndex: 0
  };

  await askForQuantity(phone, 0);
}

async function askForQuantity(phone, itemIndex) {
  const item = userOrders[phone].items[itemIndex];
  await sendWhatsAppMessage(phone,
    `How many liters of *${item.name}*? (₹${item.price}/L)`
  );
}

async function handleQuantityInput(phone, message) {
  const order = userOrders[phone];
  const qty = parseFloat(message);
  
  if (isNaN(qty) || qty <= 0) {
    await sendWhatsAppMessage(phone,
      "❌ Please enter a valid quantity (e.g. 2.5)"
    );
    return;
  }

  order.items[order.currentItemIndex].qty = qty;
  order.items[order.currentItemIndex].subtotal = qty * order.items[order.currentItemIndex].price;

  if (order.currentItemIndex < order.items.length - 1) {
    order.currentItemIndex++;
    await askForQuantity(phone, order.currentItemIndex);
  } else {
    await showOrderSummary(phone);
  }
}

async function showOrderSummary(phone) {
  const order = userOrders[phone];
  const orderId = `OIL-${Date.now().toString().slice(-6)}`;
  
  let summary = "📝 *Order Summary*\n\n";
  let total = 0;
  
  order.items.forEach(item => {
    summary += `- ${item.name} x ${item.qty}L = ₹${item.subtotal}\n`;
    total += item.subtotal;
  });
  
  summary += `\n*Total: ₹${total}*\n\n`;
  summary += "Reply:\n";
  summary += "*confirm* - To proceed with payment\n";
  summary += "*cancel* - To start over";
  
  order.step = "await_confirmation";
  order.total = total;
  order.orderId = orderId;
  
  await sendWhatsAppMessage(phone, summary);
}

async function handlePaymentRequest(phone) {
  const order = userOrders[phone];
  
  try {
    // Create Razorpay order if not already created
    if (razorpay && !order.razorpayOrderId) {
      try {
        // Amount in paise (₹100 = 10000 paise)
        const amountInPaise = Math.round(order.total * 100);
        
        const razorpayOrder = await razorpay.orders.create({
          amount: amountInPaise,
          currency: 'INR',
          receipt: order.orderId,
          notes: {
            phone: phone,
            items: order.items.map(i => `${i.name} x ${i.qty}`).join(', ')
          }
        });
        
        order.razorpayOrderId = razorpayOrder.id;
        console.log(`Razorpay order created: ${razorpayOrder.id} for ₹${order.total}`);
      } catch (error) {
        console.error("Failed to create Razorpay order:", error.message);
        await sendWhatsAppMessage(phone, "⚠️ Payment system error. Please try again later.");
        return;
      }
    }

    // Send payment instructions (only once)
    if (!order.paymentRequestSent && order.razorpayOrderId) {
      const baseUrl = (process.env.BASE_URL || `http://localhost:${port}`).replace(/^\\/, '');
      const paymentMessage = `💳 *Payment Request*\n\n` +
                           `Total: ₹${order.total}\n\n` +
                           `Pay securely via Razorpay (UPI option available):\n` +
                           `${baseUrl}/pay/${order.razorpayOrderId}\n\n` +
                           `After payment, please share your payment screenshot.`;
      
      await sendWhatsAppMessage(phone, paymentMessage);
      
      order.paymentRequestSent = true;
      order.step = "await_payment";
    }
  } catch (error) {
    console.error("Payment request failed:", error);
    await sendWhatsAppMessage(phone,
      "⚠️ Payment system error. Please try again later."
    );
  }
}

// ======================
// ROUTES
// ======================

app.get("/", (req, res) => {
  res.send("OilFacts WhatsApp Bot is running");
});

// Test endpoint
app.get("/test", (req, res) => {
  res.json({
    status: "ok",
    message: "Server is responding correctly",
    time: new Date().toISOString()
  });
});

// Webhook Verification - Simplified for maximum compatibility
app.get("/webhook", (req, res) => {
  console.log("Webhook verification request received");
  console.log(req.query);
  
  // Get parameters
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  
  // Log verification attempt
  console.log(`Mode: ${mode}, Token: ${token}, Challenge: ${challenge}`);
  console.log(`Expected token: ${process.env.VERIFY_TOKEN}`);
  
  // Always accept the challenge if token matches
  if (token === process.env.VERIFY_TOKEN) {
    console.log("WEBHOOK_VERIFIED: Token matches");
    return res.status(200).send(challenge);
  }
  
  console.log("WEBHOOK_VERIFICATION_FAILED: Token mismatch");
  return res.sendStatus(403);
});

// Razorpay payment page
app.get("/pay/:orderId", (req, res) => {
  const orderId = req.params.orderId;
  
  // Find the order with this Razorpay ID
  let orderDetails = null;
  let customerPhone = null;
  
  // Search in active orders
  Object.entries(userOrders).forEach(([phone, order]) => {
    if (order.razorpayOrderId === orderId) {
      orderDetails = order;
      customerPhone = phone;
    }
  });
  
  if (!orderDetails) {
    return res.status(404).send("Order not found");
  }
  
  // Generate a simple payment page
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>OilFacts Payment</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; }
        .container { border: 1px solid #ddd; border-radius: 5px; padding: 20px; }
        .header { background-color: #4CAF50; color: white; padding: 10px; text-align: center; border-radius: 5px 5px 0 0; margin: -20px -20px 20px; }
        .btn { background-color: #4CAF50; color: white; padding: 12px 20px; border: none; border-radius: 4px; cursor: pointer; font-size: 16px; width: 100%; }
        .order-info { margin: 20px 0; padding: 10px; background-color: #f9f9f9; border-radius: 5px; }
      </style>
      <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2>🛒 OilFacts Payment</h2>
        </div>
        
        <div class="order-info">
          <h3>Order #${orderDetails.orderId}</h3>
          <p><strong>Items:</strong> ${orderDetails.items.map(item => `${item.name} x ${item.qty}L`).join(', ')}</p>
          <p><strong>Total:</strong> ₹${orderDetails.total}</p>
        </div>
        
        <button id="pay-button" class="btn">Pay Now ₹${orderDetails.total}</button>
      </div>
      
      <script>
        document.getElementById('pay-button').onclick = function() {
          var options = {
            key: '${process.env.RAZORPAY_KEY_ID}',
            amount: ${Math.round(orderDetails.total * 100)},
            currency: 'INR',
            name: 'OilFacts',
            description: 'Order #${orderDetails.orderId}',
            order_id: '${orderId}',
            handler: function(response) {
              alert('Payment successful! Payment ID: ' + response.razorpay_payment_id);
              window.location.href = '/payment-success?orderId=${orderDetails.orderId}&paymentId=' + response.razorpay_payment_id;
            },
            prefill: {
              contact: '${customerPhone.replace(/^91/, '')}'
            },
            config: {
              display: {
                blocks: {
                  upi: {
                    name: 'Pay via UPI',
                    instruments: [
                      {
                        method: 'upi'
                      }
                    ]
                  }
                },
                sequence: ['block.upi', 'block.other'],
                preferences: {
                  show_default_blocks: true
                }
              }
            },
            theme: {
              color: '#4CAF50'
            }
          };
          var rzp = new Razorpay(options);
          rzp.open();
        };
      </script>
    </body>
    </html>
  `;
  
  res.send(html);
});

// Payment success page
app.get("/payment-success", (req, res) => {
  const orderId = req.query.orderId;
  const paymentId = req.query.paymentId;
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Payment Success</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; text-align: center; }
        .success { color: #4CAF50; font-size: 72px; margin: 20px 0; }
        .container { border: 1px solid #ddd; border-radius: 5px; padding: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="success">✅</div>
        <h2>Payment Successful!</h2>
        <p>Your order #${orderId} has been confirmed.</p>
        <p>Payment ID: ${paymentId}</p>
        <p>You can now return to WhatsApp and continue your conversation.</p>
        <p>Please share your payment screenshot in WhatsApp to complete your order.</p>
      </div>
    </body>
    </html>
  `);
});

// Message Webhook
app.post("/webhook", async (req, res) => {
  // Debug logging
  console.log("Webhook received:", JSON.stringify(req.body));
  
  // Check if ACCESS_TOKEN is valid before processing
  if (!process.env.ACCESS_TOKEN || process.env.ACCESS_TOKEN.includes('expired')) {
    console.warn("WARNING: WhatsApp API token appears to be invalid or expired. Update your .env file.");
  }
  
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const messageData = changes?.value?.messages?.[0];

    // No message data
    if (!messageData) return res.sendStatus(200);
    
    // Handle both text and image messages
    if (!messageData.text && !messageData.image) return res.sendStatus(200);

    const phone = messageData.from;
    let rawMsg = "";
    let msgBody = "";
    
    // Handle text messages
    if (messageData.text) {
      rawMsg = messageData.text.body;
      msgBody = rawMsg.trim().toLowerCase();
    }
    
    // Log incoming messages
    if (messageData.text) {
      console.log(`Received from ${phone}: ${rawMsg}`);
    } else if (messageData.image) {
      console.log(`Received image from ${phone}: ${messageData.image.id}`);
    }

    // This section is now handled above

    // ===== GREETINGS HANDLER =====
    if (/^(hi|hello|hey)$/i.test(msgBody)) {
      await sendWhatsAppMessage(phone,
        "🌟 *Welcome to OilFacts!*\n\n" +
        "Your trusted source for premium cooking oils.\n\n" +
        "Type *MENU* to see our products\n" +
        "Type *HELP* for assistance"
      );
      return res.sendStatus(200);
    }

    // ===== HELP COMMAND =====
    if (/^(help|support)$/i.test(msgBody)) {
      await sendWhatsAppMessage(phone,
        "🛎️ *How can we help?*\n\n" +
        "• Type *MENU* to order oils\n" +
        "• Type *STATUS* to check your order\n" +
        "• Contact support@oilfacts.com"
      );
      return res.sendStatus(200);
    }

    // ===== ORDER FLOW =====
    if (["menu", "order"].includes(msgBody)) {
      await handleMenuRequest(phone);
    }
    else if (userOrders[phone]?.step === "select_items") {
      await handleItemSelection(phone, rawMsg);
    }
    else if (userOrders[phone]?.step === "select_quantities") {
      await handleQuantityInput(phone, rawMsg);
    }
    else if (userOrders[phone]?.step === "await_confirmation") {
      if (msgBody === "confirm") {
        await handlePaymentRequest(phone);
      } 
      else if (msgBody === "cancel") {
        delete userOrders[phone];
        await sendWhatsAppMessage(phone, "Order cancelled. Type *MENU* to start again");
      }
      else {
        await sendWhatsAppMessage(phone, "Please reply *confirm* or *cancel*");
      }
    }
    else if (userOrders[phone]?.step === "await_payment") {
      // Check if message contains media (screenshot)
      if (messageData.image) {
        // Process the payment screenshot directly
        // Record payment info
        userOrders[phone].paymentTime = new Date().toISOString();
        userOrders[phone].paymentStatus = "PENDING_VERIFICATION";
        userOrders[phone].paymentReference = "Razorpay payment screenshot";
        userOrders[phone].screenshotMediaId = messageData.image.id;
        
        // Log payment notification
        console.log(`PAYMENT SCREENSHOT RECEIVED: Order ${userOrders[phone].orderId} - ₹${userOrders[phone].total}`);
        
        // Forward screenshot to supplier email
        try {
          // Send email with screenshot attachment
          await notifyPaymentScreenshot({
            orderId: userOrders[phone].orderId,
            phone: phone,
            total: userOrders[phone].total,
            mediaId: messageData.image.id
          });
          console.log(`Payment screenshot sent to supplier email for order ${userOrders[phone].orderId}`);
        } catch (error) {
          console.error("Failed to send payment screenshot to email:", error.message);
        }
        
        // Send confirmation and ask for address
        await sendWhatsAppMessage(phone,
          `✅ Payment screenshot received for ₹${userOrders[phone].total}!\n\n` +
          `Payment under verification. Your order will be delivered soon.\n\n` +
          "Please share your delivery address:"
        );
        userOrders[phone].step = "await_address";
      } else if (msgBody === "paid") {
        // If they type 'paid' instead of sending screenshot
        await sendWhatsAppMessage(phone,
          `Please share your payment screenshot for verification.\n\n` +
          `Upload the screenshot image showing your Razorpay payment confirmation.`
        );
      } else {
        // Remind them to complete payment and send screenshot
        const baseUrl = (process.env.BASE_URL || `http://localhost:${port}`).replace(/^\\/, '');
        await sendWhatsAppMessage(phone,
          `Please complete the payment of ₹${userOrders[phone].total} via Razorpay (UPI option available):\n\n` +
          `${baseUrl}/pay/${userOrders[phone].razorpayOrderId}\n\n` +
          `After payment, please share your payment screenshot.`
        );
      }
    }
    // await_screenshot step removed - now handled directly in await_payment
    else if (userOrders[phone]?.step === "await_address") {
      const address = rawMsg;
      
      // Complete order
      await sendWhatsAppMessage(phone,
        "🎉 *Order Complete!*\n\n" +
        `We'll deliver to:\n${address}\n\n` +
        `Order ID: ${userOrders[phone].orderId}\n` +
        "Thank you for your business!"
      );
      
      // Notify supplier
      const orderData = {
        ...userOrders[phone],
        address: address,
        phone: phone,
        needsVerification: userOrders[phone].paymentStatus === "PENDING_VERIFICATION"
      };
      
      await notifySupplier(orderData);
      
      // Save order data to file for reference before deleting from memory
      // Only save to file in development environment
      if (process.env.NODE_ENV !== 'production') {
        try {
          const ordersDir = path.join(__dirname, 'orders');
          if (!fs.existsSync(ordersDir)) {
            fs.mkdirSync(ordersDir);
          }
          
          fs.writeFileSync(
            path.join(ordersDir, `${orderData.orderId}.json`),
            JSON.stringify(orderData, null, 2)
          );
        } catch (err) {
          console.error(`Failed to save order data: ${err.message}`);
        }
      } else {
        // In production, just log the order data
        console.log(`Order completed: ${orderData.orderId}`);
      }
      
      delete userOrders[phone];
    }
    // ===== FALLBACK =====
    else {
      await sendWhatsAppMessage(phone,
        "Sorry, I didn't understand that.\n\n" +
        "Type *MENU* to see our products\n" +
        "Type *HELP* for assistance"
      );
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);
    res.sendStatus(500);
  }
});

// ======================
// TEST FUNCTIONS
// ======================

// Test function to send a WhatsApp message
app.get("/send-test/:phone", async (req, res) => {
  const phone = req.params.phone;
  
  try {
    const result = await sendWhatsAppMessage(phone, "🧪 Test message from OilFacts Bot. If you received this, the bot is working correctly!");
    console.log("Test message sent:", result);
    res.json({
      success: true,
      message: "Test message sent",
      result: result
    });
  } catch (error) {
    console.error("Failed to send test message:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ======================
// SERVER INITIALIZATION
// ======================

// Ensure directories exist (only in development environment)
if (process.env.NODE_ENV !== 'production') {
  // Create static directory if it doesn't exist
  if (!fs.existsSync(path.join(__dirname, 'static'))) {
    fs.mkdirSync(path.join(__dirname, 'static'));
  }
  
  // Create orders directory if it doesn't exist
  if (!fs.existsSync(path.join(__dirname, 'orders'))) {
    fs.mkdirSync(path.join(__dirname, 'orders'));
  }
}

// Check email configuration
if (!process.env.EMAIL_USER || !process.env.EMAIL_APP_PASSWORD) {
  console.warn('WARNING: Email is not properly configured. Please update your .env file with valid email credentials.');
}

// Check Razorpay configuration
if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  console.warn('WARNING: Razorpay is not properly configured. Payment verification will use basic validation only.');
}

app.listen(port, () => {
  console.log(`=== SERVER STARTED ===`);
  console.log(`Server running on port ${port}`);
  
  // Fix: Remove backslash from BASE_URL if present
  const baseUrl = (process.env.BASE_URL || `http://localhost:${port}`).replace(/^\\/, '');
  console.log(`Webhook URL: ${baseUrl}/webhook`);
  console.log(`Test URL: ${baseUrl}/test`);
  console.log(`Send test message: ${baseUrl}/send-test/YOUR_PHONE_NUMBER`);
  
  // Check token validity on startup
  if (!process.env.ACCESS_TOKEN) {
    console.error("ERROR: WhatsApp ACCESS_TOKEN is missing in .env file");
  } else if (process.env.ACCESS_TOKEN.includes('expired')) {
    console.error("ERROR: WhatsApp ACCESS_TOKEN appears to be marked as expired in .env file");
  } else {
    // Log that we're using the configured values
    console.log(`Using WhatsApp Phone Number ID: ${process.env.PHONE_NUMBER_ID}`);
    console.log(`Using WhatsApp Verify Token: ${process.env.VERIFY_TOKEN}`);
    console.log(`Using Base URL: ${baseUrl}`);
    
    // Test WhatsApp API token
    console.log("Testing WhatsApp API token...");
    axios.get(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}`, {
      headers: {
        Authorization: `Bearer ${process.env.ACCESS_TOKEN}`
      }
    }).then(response => {
      console.log("✅ WhatsApp API token is valid!");
    }).catch(error => {
      console.error("❌ WhatsApp API token error:", error.response?.data || error.message);
      console.error("Please update your ACCESS_TOKEN in .env file");
    });
  }
  
  console.log(`=== DEBUGGING TIPS ===`);
  console.log(`1. Make sure your ngrok URL matches BASE_URL in .env`);
  console.log(`2. Verify webhook is properly registered with Meta`);
  console.log(`3. Check WhatsApp API token is valid`);
  console.log(`4. Test sending a message with the test endpoint`);
});