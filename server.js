const express = require('express');
const app = express();

// Middleware to parse incoming JSON payloads (Crucial for M-Pesa callbacks)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 1. Health Check Endpoint (Helps Cloud Run verify your app is running smoothly)
app.get('/', (req, res) => {
    res.status(200).send('AudiSpot API Server is Live 🚀');
});

// 2. Hotspot Portal Request Endpoint
// This is where your MikroTik captive portal will send the user's phone number and selected package
app.post('/api/hotspot/login', (req, res) => {
    const { phoneNumber, amount, routerIp } = req.body;
    
    console.log(`Received request from phone: ${phoneNumber} for amount: ${amount} KES`);
    
    // TODO: Step 1: Generate Safaricom Access Token
    // TODO: Step 2: Trigger M-Pesa STK Push
    
    res.status(200).json({
        success: true,
        message: "STK Push sent successfully. Please check your phone to complete payment."
    });
});

// 3. M-Pesa Callback Endpoint
// This is the public URL Safaricom's servers will hit once the user enters their PIN
app.post('/api/mpesa/callback', (req, res) => {
    console.log("--- Received M-Pesa Callback Data ---");
    console.log(JSON.stringify(req.body, null, 2));

    // TODO: Step 1: Parse Safaricom's response body
    // TODO: Step 2: Check if ResultCode is 0 (Success)
    // TODO: Step 3: Use MikroTik API wrapper to create/enable the user on the router
    
    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted Successfully" });
});

// Listen on the port assigned by Google Cloud Run, or fallback to 8080 locally
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`AudiSpot server running on port ${PORT}`);
});