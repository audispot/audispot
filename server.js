const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Dynamically sets Safaricom host based on your Cloud Environment Variable
const MPESA_HOST = process.env.MPESA_ENV === 'production' 
    ? 'https://api.safaricom.co.ke' 
    : 'https://sandbox.safaricom.co.ke';

// 1. Health Check Home Route
app.get('/', (req, res) => {
    res.status(200).send(`AudiSpot API Server is Live 🚀 Running in ${process.env.MPESA_ENV || 'development'} mode.`);
});

// 2. Helper: Get M-Pesa OAuth Access Token
async function getMpesaToken() {
    const key = process.env.MPESA_CONSUMER_KEY;
    const secret = process.env.MPESA_CONSUMER_SECRET;
    const auth = Buffer.from(`${key}:${secret}`).toString('base64');
    
    try {
        const response = await axios.get(`${MPESA_HOST}/oauth/v1/generate?grant_type=client_credentials`, {
            headers: { Authorization: `Basic ${auth}` }
        });
        return response.data.access_token;
    } catch (error) {
        console.error("Token Generation Failed:", error.response ? error.response.data : error.message);
        throw new Error("Failed to authenticate with Safaricom");
    }
}

// 3. Hotspot Portal Endpoint: Initiates the STK Push
app.post('/api/hotspot/login', async (req, res) => {
    let { phoneNumber, amount } = req.body;

    // Normalise Kenyan Phone numbers (Forces 0712345678 or +254712345678 into 254712345678)
    if (phoneNumber.startsWith('0')) phoneNumber = '254' + phoneNumber.slice(1);
    if (phoneNumber.startsWith('+')) phoneNumber = phoneNumber.slice(1);

    try {
        const token = await getMpesaToken();
        
        // Generate M-Pesa Timestamp (Format: YYYYMMDDHHMMSS)
        const date = new Date();
        const timestamp = date.getFullYear() +
            ('0' + (date.getMonth() + 1)).slice(-2) +
            ('0' + date.getDate()).slice(-2) +
            ('0' + date.getHours()).slice(-2) +
            ('0' + date.getMinutes()).slice(-2) +
            ('0' + date.getSeconds()).slice(-2);

        // Generate Password (Base64 of Shortcode + Passkey + Timestamp)
        const shortcode = process.env.MPESA_SHORTCODE;
        const passkey = process.env.MPESA_PASSKEY;
        const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

        // M-Pesa STK Push Request Payload
        const mpesaPayload = {
            BusinessShortCode: shortcode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: "CustomerPayBillOnline", // Use CustomerBuyGoodsOnline if it's a Till number
            Amount: parseInt(amount),
            PartyA: phoneNumber,
            PartyB: shortcode,
            PhoneNumber: phoneNumber,
            CallBackURL: `${process.env.AUDISPOT_URL}/api/mpesa/callback`,
            AccountReference: "AudiSpot WiFi",
            TransactionDesc: "Internet Access Payment"
        };

        const mpesaResponse = await axios.post(`${MPESA_HOST}/mpesa/stkpush/v1/processrequest`, mpesaPayload, {
            headers: { Authorization: `Bearer ${token}` }
        });

        console.log("STK Push Success Response:", mpesaResponse.data);
        return res.status(200).json({
            success: true,
            message: "STK Push sent to device.",
            CheckoutRequestID: mpesaResponse.data.CheckoutRequestID
        });

    } catch (error) {
        console.error("STK Push Error:", error.response ? error.response.data : error.message);
        return res.status(500).json({ success: false, error: "M-Pesa payment initiation failed." });
    }
});

// 4. M-Pesa Callback Endpoint (Where Safaricom sends payment results)
app.post('/api/mpesa/callback', (req, res) => {
    const callbackData = req.body.Body.stkCallback;
    console.log("Received Payment Callback Result:", JSON.stringify(callbackData, null, 2));

    const resultCode = callbackData.ResultCode;
    const checkoutRequestID = callbackData.CheckoutRequestID;

    if (resultCode === 0) {
        // SUCCESS: Extraction of transaction data fields
        const items = callbackData.CallbackMetadata.Item;
        const mpesaReceipt = items.find(i => i.Name === 'MpesaReceiptNumber').Value;
        const amountPaid = items.find(i => i.Name === 'Amount').Value;
        const payingPhone = items.find(i => i.Name === 'PhoneNumber').Value;

        console.log(`Payment SUCCESS: ${payingPhone} paid KES ${amountPaid}. Receipt: ${mpesaReceipt}`);
        
        // TODO: This is where we will write the code to contact your MikroTik Router 
        // to automatically activate internet access for this CheckoutRequestID!
    } else {
        console.log(`Payment FAILED or CANCELLED for Request ID: ${checkoutRequestID}. Reason Code: ${resultCode}`);
    }

    // Always tell Safaricom you received their data successfully
    res.status(200).json({ ResultCode: 0, ResultDesc: "Callback received" });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`AudiSpot Server active on port ${PORT}`));