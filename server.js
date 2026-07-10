require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Firestore } = require('@google-cloud/firestore');
const MikrotikClient = require('mikrotik-node');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Cloud Firestore securely
let db;
try {
    db = new Firestore();
} catch (error) {
    console.error("Firestore initialization warning:", error.message);
}

const MPESA_HOST = process.env.MPESA_ENV === 'production' 
    ? 'https://api.safaricom.co.ke' 
    : 'https://sandbox.safaricom.co.ke';

// Helper Function: Fetch temporary Safaricom Access Token dynamically
async function getDynamicMpesaToken(consumerKey, consumerSecret) {
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    try {
        const response = await axios.get(`${MPESA_HOST}/oauth/v1/generate?grant_type=client_credentials`, {
            headers: { Authorization: `Basic ${auth}` }
        });
        return response.data.access_token;
    } catch (error) {
        console.error("Dynamic Token Generation Failed:", error.response ? error.response.data : error.message);
        throw new Error("Failed to authenticate with Safaricom using ISP credentials");
    }
}

// 1. Core Platform Health Route
app.get('/', (req, res) => {
    res.status(200).send(`AudiSpot Multi-Tenant API Gateway is Live 🚀`);
});

// 2. Admin Packages Initializer
app.get('/api/admin/init-packages', async (req, res) => {
    try {
        const packagesRef = db.collection('subscriptions').doc('packages');
        await packagesRef.set({
            standard_monthly: {
                name: "AudiSpot Core Router Access",
                price_per_router: 500,
                currency: "KES",
                features: ["M-Pesa STK Push", "Branded captive portal", "Real-time analytics", "Anti-bypass firewall"]
            }
        });
        return res.status(200).json({ success: true, message: "AudiSpot SaaS packages initialized! 💰" });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// 3. ISP User Onboarding Signup
app.post('/api/auth/isp-signup', async (req, res) => {
    const { email, password, ispName, phoneNumber, selectedPlan } = req.body;
    if (!email || !password || !ispName || !phoneNumber) {
        return res.status(400).json({ success: false, error: "All onboarding fields are required." });
    }
    try {
        const ispId = email.replace(/[^a-zA-Z0-9]/g, "_");
        await db.collection('isp_users').doc(ispId).set({
            ispName, email, password, phoneNumber,
            plan: selectedPlan || "standard_monthly",
            walletBalance: 0,
            createdAt: new Date().toISOString()
        });
        return res.status(201).json({ success: true, message: "Account created successfully!", ispId });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// 4. Register Router Endpoint
app.post('/api/isp/register-router', async (req, res) => {
    const { routerId, ispId, ispName, mpesaShortcode, mpesaPasskey, mpesaConsumerKey, mpesaConsumerSecret, routerIp, routerUser, routerPassword } = req.body;
    if (!routerId || !mpesaShortcode || !mpesaConsumerKey || !mpesaConsumerSecret) {
        return res.status(400).json({ success: false, error: "Missing required tracking parameters." });
    }
    try {
        await db.collection('routers').doc(routerId).set({
            ispId: ispId || "default_isp",
            ispName, mpesaShortcode, mpesaPasskey, mpesaConsumerKey, mpesaConsumerSecret,
            routerIp: routerIp || null,
            routerUser: routerUser || null,
            routerPassword: routerPassword || null,
            updatedAt: new Date().toISOString()
        });
        return res.status(200).json({ success: true, message: `Router ${routerId} successfully configured.` });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// 5. Multi-Tenant Hotspot Login STK Push Engine
app.post('/api/hotspot/login', async (req, res) => {
    let { phoneNumber, amount, routerId } = req.body;
    if (!routerId || !phoneNumber || !amount) {
        return res.status(400).json({ success: false, error: "Missing checkout parameters." });
    }
    if (phoneNumber.startsWith('0')) phoneNumber = '254' + phoneNumber.slice(1);

    try {
        const doc = await db.collection('routers').doc(routerId).get();
        if (!doc.exists) return res.status(404).json({ success: false, error: "Hotspot profile not found." });

        const ispConfig = doc.data();
        const token = await getDynamicMpesaToken(ispConfig.mpesaConsumerKey, ispConfig.mpesaConsumerSecret);
        
        const date = new Date();
        const timestamp = date.getFullYear() + ('0' + (date.getMonth() + 1)).slice(-2) + ('0' + date.getDate()).slice(-2) + ('0' + date.getHours()).slice(-2) + ('0' + date.getMinutes()).slice(-2) + ('0' + date.getSeconds()).slice(-2);
        const password = Buffer.from(`${ispConfig.mpesaShortcode}${ispConfig.mpesaPasskey}${timestamp}`).toString('base64');

        const mpesaPayload = {
            BusinessShortCode: ispConfig.mpesaShortcode,
            Password: password, Timestamp: timestamp,
            TransactionType: "CustomerPayBillOnline", Amount: parseInt(amount),
            PartyA: phoneNumber, PartyB: ispConfig.mpesaShortcode, PhoneNumber: phoneNumber,
            CallBackURL: `https://audispot-749056206562.europe-west1.run.app/api/mpesa/callback?routerId=${routerId}`,
            AccountReference: "AudiSpot WiFi", TransactionDesc: `WiFi Payment`
        };

        const mpesaResponse = await axios.post(`${MPESA_HOST}/mpesa/stkpush/v1/processrequest`, mpesaPayload, {
            headers: { Authorization: `Bearer ${token}` }
        });

        return res.status(200).json({ success: true, CheckoutRequestID: mpesaResponse.data.CheckoutRequestID });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// 6. Multi-Tenant M-Pesa Callback & Hardware Provisioning Hook
app.post('/api/mpesa/callback', async (req, res) => {
    const { routerId } = req.query; 
    const callbackData = req.body.Body.stkCallback;
    
    if (callbackData.ResultCode === 0) {
        try {
            const doc = await db.collection('routers').doc(routerId).get();
            if (doc.exists) {
                const ispConfig = doc.data();
                const items = callbackData.CallbackMetadata.Item;
                const amountPaid = parseFloat(items.find(i => i.Name === 'Amount').Value);
                const payingPhone = items.find(i => i.Name === 'PhoneNumber').Value;
                const mpesaReceipt = items.find(i => i.Name === 'MpesaReceiptNumber').Value;

                // Create global transaction log
                await db.collection('global_transactions').doc(mpesaReceipt).set({
                    routerId, ispOwner: ispConfig.ispName, customerPhone: payingPhone, grossAmount: amountPaid, processedAt: new Date().toISOString()
                });

                // Update ISP Wallet Balance
                const ispId = ispConfig.ispId || "default_isp";
                const ispRef = db.collection('isp_users').doc(ispId);
                await db.runTransaction(async (ts) => {
                    const ispDoc = await ts.get(ispRef);
                    if (ispDoc.exists) {
                        const currentBalance = ispDoc.data().walletBalance || 0;
                        ts.update(ispRef, { walletBalance: currentBalance + amountPaid });
                    }
                });

                // Trigger remote MikroTik router activation sequence if credentials exist
                if (ispConfig.routerIp && ispConfig.routerUser && ispConfig.routerPassword) {
                    const router = new MikrotikClient({
                        host: ispConfig.routerIp, port: parseInt(ispConfig.routerPort || '8728'),
                        user: ispConfig.routerUser, password: ispConfig.routerPassword, timeout: 10000 
                    });

                    router.connect().then(() => {
                        let dynamicPlanProfile = amountPaid >= 20 ? (amountPaid >= 50 ? "24_Hour_Plan" : "3_Hour_Plan") : "1_Hour_Plan";
                        return router.write('/ip/hotspot/user/add', [
                            `=name=${payingPhone}`, `=password=${payingPhone}`, `=profile=${dynamicPlanProfile}`, `=comment=AudiSpot_${mpesaReceipt}`
                        ]);
                    }).then(() => router.close()).catch(err => console.error("Router connection failure:", err.message));
                }
            }
        } catch (dbError) {
            console.error("Callback ledger writing exception:", dbError);
        }
    }
    res.status(200).json({ ResultCode: 0, ResultDesc: "Callback processed successfully" });
});

// 7. Fetch Wallet Statistics & Router Counts
app.get('/api/isp/dashboard-stats/:ispId', async (req, res) => {
    const { ispId } = req.params;
    try {
        const ispDoc = await db.collection('isp_users').doc(ispId).get();
        if (!ispDoc.exists) return res.status(404).json({ error: "ISP not found" });
        
        const routersSnapshot = await db.collection('routers').where('ispId', '==', ispId).get();
        return res.status(200).json({
            success: true,
            balance: ispDoc.data().walletBalance || 0,
            routerCount: routersSnapshot.size,
            ispName: ispDoc.data().ispName
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

// 8. Instant Balance Withdrawal Hook
app.post('/api/isp/withdraw', async (req, res) => {
    const { ispId, amount } = req.body;
    try {
        const ispRef = db.collection('isp_users').doc(ispId);
        const doc = await ispRef.get();
        if (!doc.exists) return res.status(404).json({ error: "Account missing" });

        const currentBalance = doc.data().walletBalance || 0;
        const wAmount = parseFloat(amount);
        if (wAmount > currentBalance || wAmount <= 0) return res.status(400).json({ error: "Invalid amount" });

        await db.runTransaction(async (ts) => {
            ts.update(ispRef, { walletBalance: currentBalance - wAmount });
        });

        await db.collection('withdrawals').add({
            ispId, amount: wAmount, phoneTarget: doc.data().phoneNumber, status: "Success", timestamp: new Date().toISOString()
        });

        return res.status(200).json({ success: true, message: "Withdrawal completed instantly!" });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`AudiSpot Engine Active on port: ${PORT}`));
