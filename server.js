const express = require('express');
const axios = require('axios');
const { Firestore } = require('@google-cloud/firestore');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Firestore. 
// Cloud Run automatically handles credentials when running inside GCP!
const db = new Firestore();

// Helper: Dynamically fetch Safaricom OAuth Token using an ISP's specific keys
async function getDynamicMpesaToken(consumerKey, consumerSecret) {
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    try {
        const response = await axios.get('https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
            headers: { Authorization: `Basic ${auth}` }
        });
        return response.data.access_token;
    } catch (error) {
        console.error("Dynamic Token Generation Failed:", error.response ? error.response.data : error.message);
        throw new Error("Failed to authenticate with Safaricom using ISP credentials");
    }
}

// 1. Health Check
app.get('/', (req, res) => {
    res.status(200).send('AudiSpot Multi-Tenant API Server is Running 🚀');
});

// 2. ISP Registration Endpoint
// Other ISPs will use this to add their router configurations to your platform
app.post('/api/isp/register-router', async (req, res) => {
    const { routerId, ispName, mpesaShortcode, mpesaPasskey, mpesaConsumerKey, mpesaConsumerSecret, routerIp, routerUser, routerPassword } = req.body;

    if (!routerId || !ispName || !mpesaShortcode || !mpesaConsumerKey || !mpesaConsumerSecret) {
        return res.status(400).json({ success: false, error: "Missing required onboarding fields." });
    }

    try {
        // Save the configurations inside a collection called "routers" using routerId as the unique key
        await db.collection('routers').doc(routerId).set({
            ispName,
            mpesaShortcode,
            mpesaPasskey,
            mpesaConsumerKey,
            mpesaConsumerSecret,
            routerIp: routerIp || null,
            routerUser: routerUser || null,
            routerPassword: routerPassword || null,
            updatedAt: new Date().toISOString()
        });

        return res.status(200).json({ success: true, message: `Router ${routerId} successfully registered under ${ispName}!` });
    } catch (error) {
        console.error("Firestore Save Error:", error);
        return res.status(500).json({ success: false, error: "Failed to save configuration to database." });
    }
});

// 3. Multi-Tenant Hotspot Login (Triggers dynamic M-Pesa push)
app.post('/api/hotspot/login', async (req, res) => {
    let { phoneNumber, amount, routerId } = req.body;

    if (!routerId) {
        return res.status(400).json({ success: false, error: "Router ID is required to identify the ISP." });
    }

    // Normalize phone formatting
    if (phoneNumber.startsWith('0')) phoneNumber = '254' + phoneNumber.slice(1);
    if (phoneNumber.startsWith('+')) phoneNumber = phoneNumber.slice(1);

    try {
        // 🔍 FETCH INDIVIDUAL ISP CONFIG FROM FIRESTORE DYNAMICALLY
        const routerRef = db.collection('routers').doc(routerId);
        const doc = await routerRef.get();

        if (!doc.exists) {
            return res.status(404).json({ success: false, error: "Hotspot profile not found on AudiSpot." });
        }

        const ispConfig = doc.data();

        // Generate temporary Safaricom token using THIS specific ISP's keys
        const token = await getDynamicMpesaToken(ispConfig.mpesaConsumerKey, ispConfig.mpesaConsumerSecret);
        
        // Setup timestamp & secure password encryption
        const date = new Date();
        const timestamp = date.getFullYear() +
            ('0' + (date.getMonth() + 1)).slice(-2) +
            ('0' + date.getDate()).slice(-2) +
            ('0' + date.getHours()).slice(-2) +
            ('0' + date.getMinutes()).slice(-2) +
            ('0' + date.getSeconds()).slice(-2);

        const password = Buffer.from(`${ispConfig.mpesaShortcode}${ispConfig.mpesaPasskey}${timestamp}`).toString('base64');

        // Build dynamic payload mapping back to the respective ISP variables
        const mpesaPayload = {
            BusinessShortCode: ispConfig.mpesaShortcode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: "CustomerPayBillOnline", 
            Amount: parseInt(amount),
            PartyA: phoneNumber,
            PartyB: ispConfig.mpesaShortcode,
            PhoneNumber: phoneNumber,
            // We pass the routerId as a query parameter so we know who to activate when Safaricom calls back!
            CallBackURL: `https://audispot-749056206562.europe-west1.run.app/api/mpesa/callback?routerId=${routerId}`,
            AccountReference: "AudiSpot WiFi",
            TransactionDesc: `Internet Access via ${ispConfig.ispName}`
        };

        const mpesaResponse = await axios.post('https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest', mpesaPayload, {
            headers: { Authorization: `Bearer ${token}` }
        });

        return res.status(200).json({
            success: true,
            message: `STK Push initialized for ${ispConfig.ispName}.`,
            CheckoutRequestID: mpesaResponse.data.CheckoutRequestID
        });

    } catch (error) {
        console.error("Multi-tenant STK Push Error:", error.response ? error.response.data : error.message);
        return res.status(500).json({ success: false, error: "M-Pesa execution failed." });
    }
});

// 4. Multi-Tenant M-Pesa Callback Endpoint
app.post('/api/mpesa/callback', async (req, res) => {
    const { routerId } = req.query; // Grab the routerId we attached to the callback URL
    const callbackData = req.body.Body.stkCallback;
    
    console.log(`Received payment callback for Router ID: ${routerId}`);

    if (callbackData.ResultCode === 0) {
        try {
            // Fetch this specific router's network address configuration to run actions against it
            const doc = await db.collection('routers').doc(routerId).get();
            if (doc.exists) {
                const ispConfig = doc.data();
                console.log(`Ready to trigger remote activation command on router: ${ispConfig.routerIp} using user ${ispConfig.routerUser}`);
                
                // TODO: Put the mikrotik-node connection block here to run commands 
                // natively against ispConfig.routerIp using the saved user credentials.
            }
        } catch (dbError) {
            console.error("Failed to read routing target on completion:", dbError);
        }
    }

    res.status(200).json({ ResultCode: 0, ResultDesc: "Callback processed" });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`AudiSpot Platform running on port ${PORT}`));