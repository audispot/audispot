require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Firestore } = require('@google-cloud/firestore');
const { RouterOSClient } = require('routeros-client');
const crypto = require('crypto');
const { sendEmail, safeStr } = require('./emailUtils');

const subscriptionTransactions = new Map();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Cloud Firestore securely with explicit project target
let db;
try {
    db = new Firestore({
        projectId: 'dotted-guru-367810'
    });
} catch (error) {
    console.error("Firestore initialization error:", error.message);
}

// ====================================================================
// CRITICAL FIX: Middleware to bind Firestore DB context globally
// ====================================================================
app.use((req, res, next) => {
    req.db = db;
    next();
});

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

// Helper Function: Trigger Safaricom B2C Payout to ISP Phone Number
async function sendMpesaB2CPayout(phoneNumber, amount, payoutId) {
    const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
    
    try {
        const tokenResponse = await axios.get(
            `${MPESA_HOST}/oauth/v1/generate?grant_type=client_credentials`, 
            { headers: { Authorization: `Basic ${auth}` } }
        );
        const accessToken = tokenResponse.data.access_token;

        const b2cUrl = `${MPESA_HOST}/mpesa/b2c/v1/paymentrequest`;
        const payload = {
            InitiatorName: process.env.MPESA_B2C_INITIATOR, 
            SecurityCredential: process.env.MPESA_B2C_SECURITY_CREDENTIAL, 
            CommandID: "BusinessPayment", 
            Amount: parseInt(amount),
            PartyA: process.env.MPESA_B2C_SHORTCODE, 
            PartyB: phoneNumber, 
            Remarks: "AudiSpot Wallet Payout",
            QueueTimeOutURL: `https://audispoty-749056206562.europe-west1.run.app/api/mpesa/b2c-timeout`,
            ResultURL: `https://audispoty-749056206562.europe-west1.run.app/api/mpesa/b2c-callback?payoutId=${payoutId}`,
            Occasion: "Withdrawal"
        };

        const response = await axios.post(b2cUrl, payload, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        return response.data;
    } catch (error) {
        console.error("Safaricom API Error:", error.response ? error.response.data : error.message);
        throw new Error("Failed to dispatch B2C payment through Safaricom");
    }
}

// Helper Function: Get RouterOS API Client instance
function getRouterClient(routerData) {
    return new RouterOSClient({
        host: routerData.routerIp,
        user: routerData.routerUser,
        password: routerData.routerPassword || '',
        port: parseInt(routerData.routerPort || '8728'),
        timeout: 10000
    });
}

// Helper: Ensure document exists with fallback default configuration schemas
async function getOrCreateSettings(databaseInstance, ispId, registrantEmail = "", registrantName = "") {
    const activeDb = databaseInstance || db;
    if (!activeDb) {
        throw new Error("Database reference is undefined. Make sure Firestore is initialized.");
    }
    
    const settingsRef = activeDb.collection('settings').doc(ispId);
    const doc = await settingsRef.get();
    
    if (!doc.exists) {
        const defaultData = {
            ispId: ispId,
            brandName: registrantName ? `${registrantName} Hotspot` : "My Premium Hotspot",
            serverIp: "10.5.5.1",
            supportPhone: "+254700000000",
            redirectUrl: "https://audispot.audiory.site/login",
            defaultPppoePassword: "AudiSpot",
            tillNumber: "",
            accountName: registrantName || "ISP Owner",
            accountEmail: registrantEmail || "owner@example.com",
            accountCompany: registrantName ? `${registrantName} Networks` : "My Network ISP",
            smsActive: false,
            smsCredits: 10,
            createdAt: new Date().toISOString()
        };
        await settingsRef.set(defaultData);
        return defaultData;
    }
    
    return doc.data();
}

// 1. Core Platform Health Route
app.get('/', (req, res) => {
    res.status(200).send(`AudiSpot Multi-Tenant API Gateway is Live 🚀`);
});

// ====================================================================
// 1. SAVE M-PESA GATEWAY CONFIGURATIONS
// ====================================================================
app.post('/api/settings/mpesa', async (req, res) => {
    const ispId = req.query.ispId || 'default_isp';
    try {
        await db.collection('settings').doc(ispId).set({
            mpesaIntegrationType: req.body.mpesaIntegrationType || 'platform',
            platformPayoutType: req.body.platformPayoutType || 'number',
            platformPrimaryDestination: req.body.platformPrimaryDestination || '',
            platformSecondaryDestination: req.body.platformSecondaryDestination || '',
            mpesaShortcode: req.body.mpesaShortcode || '',
            mpesaConsumerKey: req.body.mpesaConsumerKey || '',
            mpesaConsumerSecret: req.body.mpesaConsumerSecret || '',
            mpesaPasskey: req.body.mpesaPasskey || '',
            mpesaEnv: req.body.mpesaEnv || 'sandbox',
            tillNumber: req.body.tillNumber || ""
        }, { merge: true });
        
        return res.json({ success: true, message: "Payment configurations committed successfully." });
    } catch (err) {
        console.error("M-Pesa Settings Error:", err);
        return res.status(500).json({ error: err.message });
    }
});


// ====================================================================
// 2. DARAJA GATEWAY VERIFICATION & STK TEST ROUTINE
// ====================================================================
app.post('/api/settings/mpesa/verify-test', async (req, res) => {
    const { phone, mpesaShortcode, mpesaConsumerKey, mpesaConsumerSecret, mpesaPasskey, mpesaEnv } = req.body;
    
    if (!phone || !mpesaConsumerKey || !mpesaConsumerSecret || !mpesaShortcode) {
        return res.status(400).json({ success: false, message: "Missing required Daraja parameters for testing." });
    }

    try {
        // 1. FORMAT PHONE NUMBER TO 254...
        let cleanPhone = String(phone).replace(/[^0-9]/g, '');
        if (cleanPhone.startsWith('0')) cleanPhone = '254' + cleanPhone.slice(1);
        if (cleanPhone.startsWith('7') || cleanPhone.startsWith('1')) cleanPhone = '254' + cleanPhone;

        // 2. OAUTH ACCESS TOKEN GENERATION
        const authUrl = (mpesaEnv === 'live' || mpesaEnv === 'production')
            ? 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
            : 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';
            
        const authHeader = Buffer.from(`${mpesaConsumerKey.trim()}:${mpesaConsumerSecret.trim()}`).toString('base64');
        const tokenResponse = await axios.get(authUrl, {
            headers: { Authorization: `Basic ${authHeader}` }
        });
        
        const accessToken = tokenResponse.data.access_token;
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        const password = Buffer.from(`${mpesaShortcode.trim()}${mpesaPasskey.trim()}${timestamp}`).toString('base64');
        
        const processRequestUrl = (mpesaEnv === 'live' || mpesaEnv === 'production')
            ? 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
            : 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest';

        // 3. DYNAMIC TRANSACTION TYPE CHECK (Paybill vs Buy Goods)
        // Till Numbers (Buy Goods) are usually 6-7 digits. Paybills are 5-6 digits.
        // In Sandbox, Buy Goods is standard. In Live, default to CustomerPayBillOnline unless specified.
        const transactionType = (mpesaEnv === 'sandbox')
            ? 'CustomerBuyGoodsOnline'
            : (mpesaShortcode.trim().length >= 6 ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline');

        const stkPayload = {
            BusinessShortCode: mpesaShortcode.trim(),
            Password: password,
            Timestamp: timestamp,
            TransactionType: transactionType,
            Amount: 1, 
            PartyA: cleanPhone,
            PartyB: mpesaShortcode.trim(),
            PhoneNumber: cleanPhone,
            CallBackURL: 'https://audispoty-749056206562.europe-west1.run.app/api/mpesa/callback-test',
            AccountReference: 'AudiSpotVerify',
            TransactionDesc: 'Gateway Test Simulation'
        };

        const pushResponse = await axios.post(processRequestUrl, stkPayload, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (pushResponse.data.ResponseCode === "0") {
            return res.json({ success: true, message: "Test STK Push dispatched successfully!" });
        } else {
            return res.status(400).json({ success: false, message: pushResponse.data.ResponseDescription || "STK Push declined by gateway." });
        }
    } catch (error) {
        const errorMsg = error.response?.data?.errorMessage || error.response?.data?.ResponseDescription || error.message;
        console.error("[Daraja Validation Engine Fault]:", error.response ? error.response.data : error.message);
        return res.status(500).json({ success: false, message: `Gateway Verification Failed: ${errorMsg}` });
    }
});

// Fetch live real-time inbound logs directly from Firestore
// 1. Fetch Hotspot Logs Filtered by ISP
app.get('/api/hotspot/logs', async (req, res) => {
    const ispId = req.query.ispId || 'default_isp';
    try {
        const snapshot = await req.db.collection('payments')
            .where('ispId', '==', ispId)
            .get();

        const logs = [];
        snapshot.forEach(doc => {
            logs.push({ id: doc.id, ...doc.data() });
        });

        // Safely sort the records by creation time in-memory
        logs.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

        res.json(logs);
    } catch (err) {
        console.error("Failed fetching hotspot logs:", err);
        res.status(500).json({ error: err.message });
    }
});

// 2. Fetch Routers Filtered by ISP
app.get('/api/hotspot/routers', async (req, res) => {
    const ispId = req.query.ispId || 'default_isp';
    try {
        const snapshot = await req.db.collection('routers')
            .where('ispId', '==', ispId)
            .get();

        const routers = [];
        snapshot.forEach(doc => {
            routers.push({ id: doc.id, ...doc.data() });
        });

        res.json(routers);
    } catch (err) {
        console.error("Failed fetching routers:", err);
        res.status(500).json({ error: err.message });
    }
});

// 2. Admin Packages Initializer
app.get('/api/admin/init-packages', async (req, res) => {
    try {
        const packagesRef = db.collection('subscriptions').doc('packages');
        await packagesRef.set({
            standard_monthly: {
                name: "AudiSpot Router Core Access Pass",
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
        const registrationTimestamp = new Date().toISOString();

        await db.collection('isp_users').doc(ispId).set({
            ispName, 
            email, 
            password, 
            phoneNumber,
            plan: selectedPlan || "standard_monthly",
            walletBalance: 0,
            createdAt: registrationTimestamp
        });

        // Initialize default settings for this ISP on signup
        await getOrCreateSettings(db, ispId);

        return res.status(201).json({ 
            success: true, 
            message: "Account created successfully!", 
            ispId,
            createdAt: registrationTimestamp // Returned for frontend storage
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});
// 4. Register Router Endpoint
app.post('/api/hotspot/register-router', async (req, res) => {
    const { routerId, ispId, ispName, mpesaShortcode, mpesaPasskey, mpesaConsumerKey, mpesaConsumerSecret, routerIp, routerUser, routerPassword } = req.body;
    if (!routerId) {
        return res.status(400).json({ success: false, error: "Missing required tracking parameters." });
    }
    try {
        await db.collection('routers').doc(routerId).set({
            ispId: ispId || "default_isp",
            ispName: ispName || "AudiSpot Partner", 
            mpesaShortcode: mpesaShortcode || "4030905", 
            mpesaPasskey: mpesaPasskey || "", 
            mpesaConsumerKey: mpesaConsumerKey || "", 
            mpesaConsumerSecret: mpesaConsumerSecret || "",
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

// ====================================================================
// Multi-Tenant Hotspot Login STK Push Engine (PAYBILL & TILL FIXED)
// ====================================================================
app.post('/api/hotspot/login', async (req, res) => {
    let { phoneNumber, amount, routerId, macAddress, planProfile } = req.body;
    if (!routerId || !phoneNumber || !amount) {
        return res.status(400).json({ success: false, error: "Missing checkout parameters." });
    }
    
    // 1. Format Phone Number to International Standard (254...)
    let formattedPhone = String(phoneNumber).replace(/[^0-9]/g, '');
    if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.slice(1);
    if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) formattedPhone = '254' + formattedPhone;
    
    const targetMac = macAddress || 'nomac';
    const profileRef = planProfile || 'default';

    try {
        // 2. Lookup Router Document
        let routerDoc = await db.collection('routers').doc(routerId).get();
        let ispConfig = null;

        if (routerDoc.exists) {
            ispConfig = routerDoc.data();
        } else {
            const snapshot = await db.collection('routers').where('ispId', '==', routerId).limit(1).get();
            if (snapshot.empty) {
                return res.status(404).json({ success: false, error: "Hotspot router configuration not found." });
            }
            ispConfig = snapshot.docs[0].data();
        }

        // 3. Resolve Tenant ID
        const ispId = ispConfig.ispId || ispConfig.userId || routerId;

        // 4. Fetch ISP Gateway Choice from Firestore
        const settingsDoc = await db.collection('settings').doc(ispId).get();
        const settings = settingsDoc.exists ? settingsDoc.data() : {};

        const gatewayType = settings.mpesaIntegrationType || 'platform';

        // 5. RESOLVE CREDENTIALS (Matches your exact Cloud Run Env names)
        let consumerKey, consumerSecret, passkey, shortcode, env;

        if (gatewayType === 'daraja' && settings.mpesaConsumerKey) {
            // ISP Custom Daraja Mode
            consumerKey = settings.mpesaConsumerKey.trim();
            consumerSecret = settings.mpesaConsumerSecret.trim();
            passkey = settings.mpesaPasskey ? settings.mpesaPasskey.trim() : '';
            shortcode = settings.mpesaShortcode ? settings.mpesaShortcode.trim() : '';
            env = settings.mpesaEnv || 'sandbox';
        } else {
            // AudiSpot Platform Mode -> DIRECTLY READS CLOUD RUN ENV VARS
            consumerKey = process.env.MPESA_CONSUMER_KEY || process.env.PLATFORM_MPESA_KEY;
            consumerSecret = process.env.MPESA_CONSUMER_SECRET || process.env.PLATFORM_MPESA_SECRET;
            passkey = process.env.MPESA_PASSKEY || process.env.PLATFORM_MPESA_PASSKEY;
            shortcode = process.env.MPESA_SHORTCODE || process.env.PLATFORM_MPESA_SHORTCODE;
            env = process.env.MPESA_ENV || 'production';
        }

        // Verification check
        if (!consumerKey || !consumerSecret || !shortcode) {
            return res.status(500).json({ 
                success: false, 
                error: gatewayType === 'daraja' 
                    ? "Custom Daraja parameters incomplete in Settings." 
                    : "AudiSpot Platform M-Pesa environment variables are missing." 
            });
        }

        // 6. DARAJA AUTH TOKEN GENERATION
        const isLive = (env === 'live' || env === 'production');
        const authUrl = isLive
            ? 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
            : 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';

        const authHeader = Buffer.from(`${consumerKey.trim()}:${consumerSecret.trim()}`).toString('base64');
        const tokenRes = await axios.get(authUrl, {
            headers: { Authorization: `Basic ${authHeader}` }
        });

        const accessToken = tokenRes.data.access_token;
        if (!accessToken) {
            return res.status(500).json({ success: false, error: "Failed to obtain token from Safaricom." });
        }

        // 7. PREPARE STK PAYLOAD
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        const password = Buffer.from(`${shortcode.trim()}${passkey.trim()}${timestamp}`).toString('base64');

        const callbackUrl = `https://audispoty-749056206562.europe-west1.run.app/api/mpesa/callback?routerId=${routerId}&macAddress=${encodeURIComponent(targetMac)}&profile=${encodeURIComponent(profileRef)}`;

        const processRequestUrl = isLive
            ? 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
            : 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest';

        const cleanShortcode = shortcode.trim();
        
        // Handle Paybill vs Buy Goods dynamically:
        // Use CustomerBuyGoodsOnline ONLY if an explicit tillNumber is set in settings
        const hasTillNumber = Boolean(settings.tillNumber && settings.tillNumber.trim() !== "");
        const transactionType = hasTillNumber ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline";
        const partyB = hasTillNumber ? settings.tillNumber.trim() : cleanShortcode;

        const stkPayload = {
            BusinessShortCode: cleanShortcode,
            Password: password, 
            Timestamp: timestamp,
            TransactionType: transactionType, 
            Amount: Math.round(Number(amount)),
            PartyA: formattedPhone, 
            PartyB: partyB, 
            PhoneNumber: formattedPhone,
            CallBackURL: callbackUrl,
            AccountReference: "AudiSpot WiFi", 
            TransactionDesc: "WiFi Payment"
        };

        const pushResponse = await axios.post(processRequestUrl, stkPayload, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (pushResponse.data.ResponseCode === "0") {
            const checkoutId = pushResponse.data.CheckoutRequestID;

            const pendingDoc = {
                status: 'PENDING',
                routerId,
                ispId,
                phoneNumber: formattedPhone,
                macAddress: targetMac,
                amount: Math.round(Number(amount)),
                timestamp: new Date().toISOString()
            };

            await db.collection('stk_requests').doc(checkoutId).set(pendingDoc);
            await db.collection('stk_requests').doc(`ws_${checkoutId}`).set(pendingDoc);

            return res.status(200).json({ success: true, CheckoutRequestID: checkoutId });
        } else {
            return res.status(400).json({ 
                success: false, 
                error: pushResponse.data.ResponseDescription || "STK Push rejected by Safaricom." 
            });
        }

    } catch (error) {
        console.error("STK Push Error Details:", error.response ? error.response.data : error.message);
        const errMsg = error.response?.data?.errorMessage || error.response?.data?.ResponseDescription || error.message;
        return res.status(500).json({ success: false, error: errMsg });
    }
});

// ====================================================================
// 6. DYNAMIC M-PESA CALLBACK & DUAL-GATEWAY REVENUE ENGINE
// ====================================================================
app.post('/api/mpesa/callback', async (req, res) => {
    console.log("=== INCOMING MPESA CALLBACK ===");
    console.log("Query:", req.query);
    console.log("Body:", JSON.stringify(req.body));

    const { routerId, macAddress, profile } = req.query; 
    const callbackData = req.body?.Body?.stkCallback;

    if (!callbackData) {
        return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    const checkoutId = callbackData.CheckoutRequestID;
    
    if (callbackData.ResultCode === 0) {
        try {
            const items = callbackData.CallbackMetadata?.Item || [];
            const amountPaid = parseFloat(items.find(i => i.Name === 'Amount')?.Value || 0);
            const payingPhone = String(items.find(i => i.Name === 'PhoneNumber')?.Value || '');
            const mpesaReceipt = items.find(i => i.Name === 'MpesaReceiptNumber')?.Value || '';
            const cleanMac = macAddress ? macAddress.toLowerCase().replace(/[^a-f0-9]/g, '') : 'nomac';

            console.log(`Payment SUCCESS! Receipt: ${mpesaReceipt}, CheckoutID: ${checkoutId}, Amount: ${amountPaid}`);

            // 1. UPDATE STK REQUEST STATUS
            if (checkoutId) {
                const stkBatch = db.batch();
                stkBatch.set(db.collection('stk_requests').doc(checkoutId), { status: 'PAID', receipt: mpesaReceipt, updatedAt: new Date().toISOString() }, { merge: true });
                stkBatch.set(db.collection('stk_requests').doc(`ws_${checkoutId}`), { status: 'PAID', receipt: mpesaReceipt, updatedAt: new Date().toISOString() }, { merge: true });
                await stkBatch.commit();
            }

            // 2. MULTI-TENANT ISOLATION: RESOLVE REAL ISP TENANT ID
            let ispId = "default_isp";
            let ispConfig = null;

            if (routerId) {
                const routerDoc = await db.collection('routers').doc(routerId).get();
                if (routerDoc.exists) {
                    ispConfig = routerDoc.data();
                    // Multi-tenant resolution sequence: explicit ispId -> owner userId -> routerId identifier
                    ispId = ispConfig.ispId || ispConfig.userId || routerId;
                } else {
                    // Fallback to routerId if registered directly as account email/ID
                    ispId = routerId;
                }
            }

            // Fetch ISP Settings to verify Gateway Mode (Platform vs Custom Daraja)
            const settingsDoc = await db.collection('settings').doc(ispId).get();
            const gatewayType = settingsDoc.exists ? (settingsDoc.data().mpesaIntegrationType || 'platform') : 'platform';

            // 3. DYNAMIC DURATION LOOKUP FROM ISP_PACKAGES
            let durationHours = 1; 
            let bandwidthProfile = profile || "Default_Limit";

            try {
                // Attempt to match package owned by this specific ISP tenant
                let packageQuery = await db.collection('isp_packages')
                    .where('ispId', '==', ispId)
                    .where('price', '==', amountPaid)
                    .limit(1)
                    .get();

                // Secondary query fallback using routerId
                if (packageQuery.empty && routerId) {
                    packageQuery = await db.collection('isp_packages')
                        .where('routerId', '==', routerId)
                        .where('price', '==', amountPaid)
                        .limit(1)
                        .get();
                }

                if (!packageQuery.empty) {
                    const matchedPkg = packageQuery.docs[0].data();
                    durationHours = parseFloat(matchedPkg.duration) || 1;
                    if (matchedPkg.bandwidthProfile) {
                        bandwidthProfile = matchedPkg.bandwidthProfile;
                    }
                } else {
                    if (amountPaid >= 2000) durationHours = 720;     
                    else if (amountPaid >= 500) durationHours = 168;  
                    else if (amountPaid >= 50) durationHours = 12;    
                    else if (amountPaid >= 20) durationHours = 3;     
                    else if (amountPaid >= 10) durationHours = 2;     
                }
            } catch (pkgErr) {
                console.error("Dynamic package lookup error:", pkgErr.message);
            }

            // 4. SAVE ISOLATED TRANSACTION RECORD
            if (mpesaReceipt) {
                const transactionPayload = {
                    mpesaReceipt: mpesaReceipt,
                    grossAmount: amountPaid,
                    durationHours: durationHours,
                    phoneNumber: payingPhone,
                    customerPhone: payingPhone,
                    macAddress: cleanMac,
                    routerId: routerId || "unknown",
                    ispId: ispId, // Strictly binds payment to the correct tenant
                    gatewayType: gatewayType, // 'platform' or 'custom_daraja'
                    profileName: bandwidthProfile,
                    timestamp: new Date().toISOString(),
                    createdAt: new Date().toISOString(),
                    status: 'SUCCESS'
                };

                await db.collection('transactions').doc(mpesaReceipt).set(transactionPayload, { merge: true });
                await db.collection('global_transactions').doc(mpesaReceipt).set(transactionPayload, { merge: true });
            }

            // 5. CREDIT ISP OWNER DASHBOARD WALLET (ONLY IF USING PLATFORM GATEWAY)
            if (ispId && ispId !== 'default_isp' && gatewayType === 'platform') {
                const ispRef = db.collection('isp_users').doc(ispId);
                await db.runTransaction(async (ts) => {
                    const iDoc = await ts.get(ispRef);
                    if (iDoc.exists) {
                        const currentBal = iDoc.data().walletBalance || 0;
                        ts.update(ispRef, { walletBalance: currentBal + amountPaid });
                        console.log(`Credited ISP ${ispId} platform wallet with +KES ${amountPaid}.`);
                    }
                });
            } else {
                console.log(`ISP ${ispId} uses Custom Daraja Gateway or Default Pool. Funds settled directly.`);
            }

            // ====================================================================
            // 6. UPDATE SUBSCRIBER RECORD (DYNAMIC LOYALTY POINTS LOOKUP)
            // ====================================================================
            let pointsToAward = 1; // Default fallback if not configured by ISP

            try {
                const portalDesignDoc = await db.collection('isp_portals').doc(ispId).get();
                if (portalDesignDoc.exists) {
                    const portalData = portalDesignDoc.data();
                    if (portalData.pointsEarnedPerPurchase !== undefined) {
                        pointsToAward = parseInt(portalData.pointsEarnedPerPurchase, 10) || 1;
                    } else if (portalData.pointsEarned !== undefined) {
                        pointsToAward = parseInt(portalData.pointsEarned, 10) || 1;
                    }
                }
            } catch (portalErr) {
                console.error("Error reading ISP portal design for points:", portalErr.message);
            }

            if (cleanMac !== 'nomac') {
                const subRef = db.collection('subscribers').doc(cleanMac);
                await db.runTransaction(async (ts) => {
                    const subDoc = await ts.get(subRef);
                    const currentPoints = subDoc.exists ? (subDoc.data().loyaltyPoints || 0) : 0;
                    ts.set(subRef, {
                        phoneNumber: payingPhone,
                        loyaltyPoints: currentPoints + pointsToAward, // Now dynamic!
                        lastActivePackage: amountPaid,
                        lastActiveTimestamp: new Date().toISOString(),
                        routerId: routerId || 'unknown',
                        ispId: ispId
                    }, { merge: true });
                });
            }

            // 7. DIRECT ROUTER PROVISIONING VIA MIKROTIK API
            if (ispConfig && ispConfig.routerIp && ispConfig.routerUser && ispConfig.routerPassword) {
                let api = null;
                try {
                    const client = getRouterClient(ispConfig);
                    api = await client.connect();
                    
                    // Check if user entry already exists to avoid MikroTik duplicate add errors
                    const existingUsers = await api.write('/ip/hotspot/user/print', [
                        `.query=name=${payingPhone}`
                    ]);

                    if (existingUsers && existingUsers.length > 0) {
                        const userId = existingUsers[0]['.id'];
                        await api.write('/ip/hotspot/user/set', [
                            `=.id=${userId}`,
                            `=profile=${bandwidthProfile}`,
                            `=comment=AudiSpot_${cleanMac}_${mpesaReceipt}`
                        ]);
                    } else {
                        await api.write('/ip/hotspot/user/add', [
                            `=name=${payingPhone}`, 
                            `=password=${payingPhone}`, 
                            `=profile=${bandwidthProfile}`, 
                            `=comment=AudiSpot_${cleanMac}_${mpesaReceipt}`
                        ]);
                    }
                } catch (rErr) {
                    console.error("Router provisioning error:", rErr.message);
                } finally {
                    if (api) await api.close(); // Guarantee connection closes safely
                }
            }

        } catch (dbError) {
            console.error("Callback processing exception:", dbError);
        }
    } else {
        if (checkoutId) {
            await db.collection('stk_requests').doc(checkoutId).set({ status: 'FAILED' }, { merge: true });
            await db.collection('stk_requests').doc(`ws_${checkoutId}`).set({ status: 'FAILED' }, { merge: true });
        }
    }

    return res.status(200).json({ ResultCode: 0, ResultDesc: "Callback processed successfully" });
});

// Polling Route to check payment progress inside connect.html
app.get('/api/hotspot/check-payment/:checkoutId', async (req, res) => {
    try {
        const rawId = req.params.checkoutId;
        
        // Check raw ID or 'ws_' prefix
        let doc = await db.collection('stk_requests').doc(rawId).get();
        if (!doc.exists) {
            doc = await db.collection('stk_requests').doc(`ws_${rawId}`).get();
        }

        if (!doc.exists) return res.status(404).json({ success: false, status: 'NOT_FOUND' });
        
        const data = doc.data();
        return res.status(200).json({ 
            success: true, 
            status: data.status, 
            receipt: data.receipt || data.mpesaReceiptNumber || '' 
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ====================================================================
// DYNAMIC STK PUSH INITIATOR (Supports Custom Daraja & Platform)
// ====================================================================
app.post('/api/mpesa/stkpush', async (req, res) => {
    try {
        const { phoneNumber, amount, routerId, macAddress, profile } = req.body;

        if (!phoneNumber || !amount) {
            return res.status(400).json({ success: false, message: "Phone number and amount are required." });
        }

        // 1. RESOLVE TENANT ISP ID FROM ROUTER
        let ispId = "default_isp";
        if (routerId) {
            const routerDoc = await db.collection('routers').doc(routerId).get();
            if (routerDoc.exists) {
                const rData = routerDoc.data();
                ispId = rData.ispId || rData.userId || routerId;
            } else {
                ispId = routerId;
            }
        }

        // 2. FETCH GATEWAY SETTINGS FROM FIRESTORE
        const settingsDoc = await db.collection('settings').doc(ispId).get();
        const settings = settingsDoc.exists ? settingsDoc.data() : {};

        // Check if ISP uses Custom Daraja vs Platform
        const isCustomDaraja = settings.mpesaIntegrationType === 'daraja' && settings.mpesaConsumerKey;

        // Determine Credentials based on Gateway Type
        const consumerKey = isCustomDaraja ? settings.mpesaConsumerKey : process.env.PLATFORM_MPESA_KEY;
        const consumerSecret = isCustomDaraja ? settings.mpesaConsumerSecret : process.env.PLATFORM_MPESA_SECRET;
        const passkey = isCustomDaraja ? settings.mpesaPasskey : process.env.PLATFORM_MPESA_PASSKEY;
        const shortcode = isCustomDaraja ? settings.mpesaShortcode : process.env.PLATFORM_MPESA_SHORTCODE;
        const env = isCustomDaraja ? (settings.mpesaEnv || 'sandbox') : 'production';

        // 3. GENERATE DARAJA ACCESS TOKEN
        const authUrl = env === 'live' || env === 'production'
            ? 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
            : 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';

        const authHeader = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
        const authRes = await fetch(authUrl, {
            headers: { Authorization: `Basic ${authHeader}` }
        });
        const authData = await authRes.json();

        if (!authRes.ok || !authData.access_token) {
            return res.status(400).json({ success: false, message: "Failed to authenticate with M-Pesa gateway." });
        }

        // 4. PREPARE STK PUSH PAYLOAD
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

        // Formats phone number to 254...
        let formattedPhone = String(phoneNumber).replace(/[^0-9]/g, '');
        if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.slice(1);
        if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) formattedPhone = '254' + formattedPhone;

        const callbackUrl = `${process.env.BASE_URL || 'https://your-domain.com'}/api/mpesa/callback?routerId=${encodeURIComponent(routerId || '')}&macAddress=${encodeURIComponent(macAddress || '')}&profile=${encodeURIComponent(profile || '')}`;

        const stkUrl = env === 'live' || env === 'production'
            ? 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
            : 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest';

        const stkPayload = {
            BusinessShortCode: shortcode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: 'CustomerPayBillOnline',
            Amount: Math.round(Number(amount)),
            PartyA: formattedPhone,
            PartyB: shortcode,
            PhoneNumber: formattedPhone,
            CallBackURL: callbackUrl,
            AccountReference: `WiFi_${macAddress ? macAddress.slice(-4) : 'Spot'}`,
            TransactionDesc: 'Internet Package Purchase'
        };

        // 5. DISPATCH STK PUSH TO SAFARICOM
        const stkRes = await fetch(stkUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authData.access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(stkPayload)
        });

        const stkData = await stkRes.json();

        if (stkRes.ok && stkData.ResponseCode === '0') {
            const checkoutId = stkData.CheckoutRequestID;

            // Save pending STK request to Firestore so callback can match it
            await db.collection('stk_requests').doc(checkoutId).set({
                status: 'PENDING',
                phoneNumber: formattedPhone,
                amount: amount,
                routerId: routerId || '',
                macAddress: macAddress || '',
                ispId: ispId,
                createdAt: new Date().toISOString()
            });

            return res.json({
                success: true,
                checkoutRequestId: checkoutId,
                message: "STK Push sent to phone."
            });
        } else {
            return res.status(400).json({
                success: false,
                message: stkData.errorMessage || stkData.ResponseDescription || "STK Push request failed."
            });
        }

    } catch (err) {
        console.error("STK Push error:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 7. Fetch Dual-Gateway Wallet & Revenue Statistics
app.get('/api/isp/dashboard-stats/:ispId', async (req, res) => {
    const { ispId } = req.params;
    try {
        const ispDoc = await db.collection('isp_users').doc(ispId).get();
        if (!ispDoc.exists) return res.status(404).json({ error: "ISP not found" });

        const settingsDoc = await db.collection('settings').doc(ispId).get();
        const settings = settingsDoc.exists ? settingsDoc.data() : {};

        // Calculate start of today (Midnight)
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        // Create 30-Day Buckets Map for the Revenue Chart
        const daysMap = {};
        for (let i = 29; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
            const dateStr = d.toISOString().split('T')[0]; // YYYY-MM-DD
            daysMap[dateStr] = 0;
        }

        // 1. Fetch transactions from global_transactions
        const txSnapshot = await db.collection('global_transactions')
            .where('ispId', '==', ispId)
            .get();

        let totalGrossEarned = 0;
        let totalSalesCount = 0;
        let todayRevenue = 0;
        let todayPaymentsCount = 0;
        const todayPayments = [];

        txSnapshot.forEach(doc => {
            const data = doc.data();
            const amount = parseFloat(data.grossAmount || data.amount) || 0;
            const status = (data.status || 'completed').toLowerCase();

            if (status === 'completed' || status === 'success') {
                totalGrossEarned += amount;
                totalSalesCount++;

                // Handle date conversion safely
                const txDate = data.createdAt?.toDate ? data.createdAt.toDate() : new Date(data.createdAt || data.date || Date.now());

                // Populate 30-Day Chart Aggregation
                const dayKey = txDate.toISOString().split('T')[0];
                if (daysMap[dayKey] !== undefined) {
                    daysMap[dayKey] += amount;
                }

                if (txDate >= startOfToday) {
                    todayRevenue += amount;
                    todayPaymentsCount++;
                    todayPayments.push({
                        receipt: data.receipt || data.mpesaReceipt || doc.id.substring(0, 10).toUpperCase(),
                        phone: data.phoneNumber || data.phone || data.customer || 'N/A',
                        router: data.routerName || data.router || 'Main Router',
                        amount: amount,
                        status: 'completed',
                        date: txDate
                    });
                }
            }
        });

        // Sort today's payments (newest first)
        todayPayments.sort((a, b) => b.date - a.date);

        // 2. Fetch Routers
        const routersSnapshot = await db.collection('routers').where('ispId', '==', ispId).get();

        // 3. Bulletproof Vouchers Fetch (Now specifically querying isp_vouchers!)
        const vouchersDocs = [];
        let vSnap = await db.collection('isp_vouchers').where('ispId', '==', ispId).get();
        if (vSnap.empty) vSnap = await db.collection('isp_vouchers').where('isp_id', '==', ispId).get();
        if (vSnap.empty) vSnap = await db.collection('vouchers').where('ispId', '==', ispId).get();
        if (vSnap.empty) vSnap = await db.collection('hotspot_vouchers').where('ispId', '==', ispId).get();
        
        vSnap.forEach(doc => vouchersDocs.push(doc.data()));

        let todayVouchersCount = 0;
        vouchersDocs.forEach(vData => {
            const vDate = vData.createdAt?.toDate ? vData.createdAt.toDate() : new Date(vData.createdAt || Date.now());
            if (vDate >= startOfToday) todayVouchersCount++;
        });

        // 4. Bulletproof Hotspot Users Online Check
        let activeUsersOnline = 0;
        let sessionSnap = await db.collection('active_sessions').where('ispId', '==', ispId).where('status', '==', 'active').get();
        if (sessionSnap.empty) {
            sessionSnap = await db.collection('active_sessions').where('isp_id', '==', ispId).where('status', '==', 'active').get();
        }
        if (sessionSnap.empty) {
            sessionSnap = await db.collection('isp_vouchers').where('ispId', '==', ispId).where('status', '==', 'Used').get();
        }
        activeUsersOnline = sessionSnap.size;

        const ispData = ispDoc.data();

        // Prepare Chart Labels and Data Arrays
        const chartLabels = Object.keys(daysMap).map(d => {
            const parts = d.split('-');
            const dateObj = new Date(parts[0], parts[1] - 1, parts[2]);
            return `${dateObj.getDate()} ${dateObj.toLocaleString('en-US', { month: 'short' })}`;
        });
        const chartValues = Object.values(daysMap);

        return res.status(200).json({
            success: true,
            gatewayType: settings.mpesaIntegrationType || 'platform',
            tillNumber: settings.tillNumber || settings.mpesaShortcode || 'N/A',
            withdrawableBalance: ispData.walletBalance || 0,
            phoneNumber: settings.supportPhone || ispData.phoneNumber || "",
            createdAt: ispData.createdAt || null,
            totalGrossEarned: totalGrossEarned,
            totalSalesCount: totalSalesCount,
            todayRevenue: todayRevenue,
            todayPaymentsCount: todayPaymentsCount,
            todayPayments: todayPayments,
            routerCount: routersSnapshot.size,
            hotspotUsersOnline: activeUsersOnline,
            hotspotVouchersTotal: vouchersDocs.length,
            hotspotVouchersToday: todayVouchersCount,
            ispName: ispData.ispName,
            chartData: {
                labels: chartLabels,
                values: chartValues
            }
        });
    } catch (error) {
        console.error("Error fetching dashboard stats:", error);
        return res.status(500).json({ error: error.message });
    }
});

// 8a. Request Balance Withdrawal via Safaricom B2C
app.post('/api/isp/withdraw', async (req, res) => {
    const { ispId, amount } = req.body;
    if (!ispId || !amount) {
        return res.status(400).json({ success: false, error: "Missing withdrawal parameters." });
    }

    try {
        const ispRef = db.collection('isp_users').doc(ispId);
        const wAmount = parseFloat(amount);

        if (isNaN(wAmount) || wAmount <= 0) {
            return res.status(400).json({ success: false, error: "Invalid amount." });
        }
        
        const transactionResult = await db.runTransaction(async (transaction) => {
            const ispDoc = await transaction.get(ispRef);
            if (!ispDoc.exists) throw new Error("Account missing.");

            const currentBalance = ispDoc.data().walletBalance || 0;
            const phoneNumber = ispDoc.data().phoneNumber;

            if (wAmount > currentBalance) throw new Error("Insufficient wallet balance.");

            transaction.update(ispRef, { walletBalance: currentBalance - wAmount });

            const payoutRef = db.collection('withdrawals').doc();
            transaction.set(payoutRef, {
                ispId,
                amount: wAmount,
                phoneTarget: phoneNumber,
                status: "Pending_Safaricom",
                timestamp: new Date().toISOString(),
                payoutId: payoutRef.id
            });

            return { phoneNumber, payoutId: payoutRef.id };
        });

        const b2cResponse = await sendMpesaB2CPayout(transactionResult.phoneNumber, wAmount, transactionResult.payoutId);

        if (b2cResponse.ResponseCode === "0") {
            return res.status(200).json({ 
                success: true, 
                message: "Withdrawal request submitted to M-Pesa. Processing...", 
                payoutId: transactionResult.payoutId 
            });
        } else {
            await ispRef.update({ walletBalance: admin.firestore.FieldValue.increment(wAmount) });
            await db.collection('withdrawals').doc(transactionResult.payoutId).update({ 
                status: "Failed", 
                error: b2cResponse.ResponseDescription || "Rejected by Safaricom" 
            });
            return res.status(500).json({ success: false, error: b2cResponse.ResponseDescription });
        }
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// 4b. Dynamic Terminal Script Generation Factory Layer
app.post('/api/hotspot/generate-script', async (req, res) => {
    const { routerId, ispId } = req.body;
    if (!routerId) {
        return res.status(400).json({ success: false, error: "Target router key configuration index is missing." });
    }

    const defaultIspId = ispId || "default_isp";
    
    try {
        const routerRef = db.collection('routers').doc(routerId);
        let doc = await routerRef.get();
        
        if (!doc.exists) {
            await routerRef.set({
                ispId: defaultIspId,
                ispName: "AudiSpot Partner",
                mpesaShortcode: "4030905",
                mpesaPasskey: "",
                mpesaConsumerKey: "",
                mpesaConsumerSecret: "",
                routerIp: "0.0.0.0",
                routerUser: "admin",
                updatedAt: new Date().toISOString()
            });
            doc = await routerRef.get();
        }

        const resolvedIspId = doc.data()?.ispId || defaultIspId;

        // Script targets /connect/index.html and injects the ISP context
        const provisioningScript = `/sys identity set name="${routerId}";
/ip hotspot profile add name="AudiSpot_Prof" hotspot-address=10.5.5.1 login-by=http-chap,http-pap;
/ip hotspot profile set "AudiSpot_Prof" html-directory=flash/connect;
/ip hotspot walled-garden add dst-host="safaricom.co.ke" action=allow;
/ip hotspot walled-garden add dst-host="audiory.site" action=allow;
/ip hotspot walled-garden add dst-host="audispoty-749056206562.europe-west1.run.app" action=allow;
/tool fetch url="https://audispot.audiory.site/connect/index.html?ispId=${resolvedIspId}" dst-path="flash/connect/index.html";
:log info "AudiSpot Capital Edge Captive Gateway Core Stack Installed Successfully Instance ID: ${routerId}";`;

        return res.status(200).json({ success: true, script: provisioningScript });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ====================================================================
// PACKAGES ENGINE: CREATE, READ, & DELETE BILLING PROFILES
// ====================================================================

app.get('/api/packages', async (req, res) => {
    const { ispId } = req.query;
    const targetTenant = ispId || "default_isp";
    try {
        const snapshot = await db.collection('isp_packages')
            .where('ispId', '==', targetTenant)
            .get();
            
        const packages = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            packages.push({
                id: doc.id,
                packageName: data.packageName || "Unnamed Tier",
                price: data.price || 0,
                duration: data.duration || 0,
                bandwidthProfile: data.bandwidthProfile || "Default_Limit"
            });
        });
        
        return res.status(200).json(packages);
    } catch (error) {
        console.error("Failed to fetch custom billing packages:", error.message);
        return res.status(500).json({ error: error.message });
    }
});

app.post('/api/packages/create', async (req, res) => {
    const { ispId, packageName, price, duration, bandwidthProfile } = req.body;
    
    if (!packageName || !price || !duration || !bandwidthProfile) {
        return res.status(400).json({ success: false, error: "Missing required configuration fields." });
    }
    
    try {
        const newPackageRef = db.collection('isp_packages').doc();
        await newPackageRef.set({
            ispId: ispId || "default_isp",
            packageName,
            price: parseFloat(price),
            duration: parseInt(duration),
            bandwidthProfile,
            createdAt: new Date().toISOString()
        });
        
        return res.status(200).json({ success: true, id: newPackageRef.id });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/packages/delete', async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, error: "Missing document unique identity." });
    
    try {
        await db.collection('isp_packages').doc(id).delete();
        return res.status(200).json({ success: true, message: "Billing package item scrubbed." });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ====================================================================
// LOYALTY PROGRAM: BALANCE CHECK & REDEMPTION
// ====================================================================

app.get('/api/hotspot/loyalty/balance', async (req, res) => {
    const { macAddress } = req.query;
    if (!macAddress) return res.status(400).json({ error: "MAC Address parameter is required." });
    
    // Normalize MAC address format
    const cleanMac = macAddress.toLowerCase().replace(/[^a-f0-9]/g, '');

    try {
        const subDoc = await db.collection('subscribers').doc(cleanMac).get();
        if (!subDoc.exists) {
            return res.status(200).json({ points: 0, phoneNumber: null });
        }
        
        const data = subDoc.data();
        return res.status(200).json({
            points: data.loyaltyPoints || 0,
            phoneNumber: data.phoneNumber || null
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

app.post('/api/hotspot/loyalty/redeem', async (req, res) => {
    const { macAddress, routerId, pointsToRedeem, targetProfile } = req.body; 

    if (!macAddress || !routerId) {
        return res.status(400).json({ success: false, error: "Missing required identity parameter (macAddress / routerId)." });
    }

    const cleanMac = macAddress.toLowerCase().replace(/[^a-f0-9]/g, '');

    try {
        // 1. RESOLVE ROUTER & ISP TENANT ID
        const routerDoc = await db.collection('routers').doc(routerId).get();
        if (!routerDoc.exists) {
            return res.status(404).json({ success: false, error: "Router network not found." });
        }
        
        const routerData = routerDoc.data();
        const ispId = routerData.ispId || routerData.userId || "default_isp";

        // 2. FETCH ISP DYNAMIC REWARD TIERS CONFIGURATION
        let requiredPoints = parseInt(pointsToRedeem, 10) || 100;
        let selectedProfile = targetProfile || "24_Hour_Plan";
        let tierDisplayName = "Reward Pass";

        try {
            // First check ISP Portal Design Document
            const portalDoc = await db.collection('isp_portals').doc(ispId).get();
            let rewardTiers = [];

            if (portalDoc.exists && portalDoc.data().rewardTiers) {
                rewardTiers = portalDoc.data().rewardTiers;
            }

            // Find matching tier based on selected profile or point cost passed from frontend
            if (Array.isArray(rewardTiers) && rewardTiers.length > 0) {
                const matchedTier = rewardTiers.find(t => 
                    (targetProfile && (t.mikrotikProfile === targetProfile || t.profile === targetProfile)) ||
                    (pointsToRedeem && parseInt(t.points, 10) === parseInt(pointsToRedeem, 10))
                );

                if (matchedTier) {
                    requiredPoints = parseInt(matchedTier.points || matchedTier.pointsRequired, 10);
                    selectedProfile = matchedTier.mikrotikProfile || matchedTier.profile || selectedProfile;
                    tierDisplayName = matchedTier.displayName || matchedTier.name || `${requiredPoints} Points Pass`;
                }
            }
        } catch (tierErr) {
            console.error("Error reading ISP reward tiers config:", tierErr.message);
        }

        // 3. ATOMIC TRANSACTION: DEDUCT POINTS & SAVE REDEMPTION AUDIT RECORD
        const subRef = db.collection('subscribers').doc(cleanMac);

        const subscriberData = await db.runTransaction(async (ts) => {
            const subDoc = await ts.get(subRef);
            if (!subDoc.exists) {
                throw new Error("Subscriber profile not found.");
            }

            const currentPoints = subDoc.data().loyaltyPoints || 0;
            if (currentPoints < requiredPoints) {
                throw new Error(`Insufficient points balance. You need ${requiredPoints} points but have ${currentPoints}.`);
            }

            // Calculate new deducted points
            const newPointBalance = currentPoints - requiredPoints;

            // Update Subscriber points in Firestore
            ts.update(subRef, {
                loyaltyPoints: newPointBalance,
                lastActiveTimestamp: new Date().toISOString()
            });

            // Save Redemption Document for ISP Dashboard Analytics
            const redemptionRef = db.collection('loyalty_redemptions').doc();
            ts.set(redemptionRef, {
                redemptionId: redemptionRef.id,
                ispId: ispId,
                routerId: routerId,
                macAddress: cleanMac,
                phoneNumber: subDoc.data().phoneNumber || cleanMac,
                pointsDeducted: requiredPoints,
                remainingPoints: newPointBalance,
                grantedProfile: selectedProfile,
                rewardName: tierDisplayName,
                timestamp: new Date().toISOString()
            });

            return {
                phoneNumber: subDoc.data().phoneNumber || cleanMac,
                remainingPoints: newPointBalance
            };
        });

        // 4. PROVISION ACCESS ON MIKROTIK ROUTER
        if (routerData.routerIp && routerData.routerUser && routerData.routerPassword) {
            let api = null;
            try {
                const client = getRouterClient(routerData);
                api = await client.connect();

                const userIdentifier = subscriberData.phoneNumber;

                // Check if user already exists in MikroTik
                const existingUsers = await api.write('/ip/hotspot/user/print', [
                    `.query=name=${userIdentifier}`
                ]);

                if (existingUsers && existingUsers.length > 0) {
                    const userId = existingUsers[0]['.id'];
                    await api.write('/ip/hotspot/user/set', [
                        `=.id=${userId}`,
                        `=profile=${selectedProfile}`,
                        `=comment=LoyaltyRedeem_${cleanMac}_${Date.now()}`
                    ]);
                } else {
                    await api.write('/ip/hotspot/user/add', [
                        `=name=${userIdentifier}`,
                        `=password=${userIdentifier}`,
                        `=profile=${selectedProfile}`,
                        `=comment=LoyaltyRedeem_${cleanMac}`
                    ]);
                }
            } catch (routerErr) {
                console.error("MikroTik Provisioning Error during redemption:", routerErr.message);
                // Return success since points were deducted, but alert client to reconnect
                return res.status(200).json({
                    success: true,
                    message: "Points redeemed! Please reconnect to the Wi-Fi network.",
                    remainingPoints: subscriberData.remainingPoints
                });
            } finally {
                if (api) await api.close(); // Clean up router connection
            }
        }

        return res.status(200).json({
            success: true,
            message: `Successfully redeemed ${tierDisplayName}!`,
            remainingPoints: subscriberData.remainingPoints
        });

    } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
    }
});

// ====================================================================
// RECONNECT SESSION ENGINE (AUTO-LOGIN ALREADY PAID DEVICES)
// ====================================================================

app.get('/api/hotspot/reconnect', async (req, res) => {
    const { macAddress, routerId } = req.query;
    if (!macAddress || !routerId) return res.status(400).json({ error: "Missing verification criteria." });

    const cleanMac = macAddress.toLowerCase().replace(/[^a-f0-9]/g, '');

    try {
        const subDoc = await db.collection('subscribers').doc(cleanMac).get();
        if (!subDoc.exists) return res.status(404).json({ error: "No recorded paid subscriptions mapped to this device." });

        const subData = subDoc.data();
        const lastActiveTime = new Date(subData.lastActiveTimestamp);
        const diffInMinutes = (new Date() - lastActiveTime) / 60000;

        const lastPaidAmount = subData.lastActivePackage || 0;
        let validityDurationMinutes = 60; 
        if (lastPaidAmount >= 50) validityDurationMinutes = 1440; 
        else if (lastPaidAmount >= 20) validityDurationMinutes = 180; 

        if (diffInMinutes < validityDurationMinutes) {
            const routerDoc = await db.collection('routers').doc(routerId).get();
            if (routerDoc.exists) {
                const rData = routerDoc.data();
                if (rData.routerIp && rData.routerUser && rData.routerPassword) {
                    try {
                        const client = getRouterClient(rData);
                        const api = await client.connect();
                        
                        let dynamicProfile = lastPaidAmount >= 20 ? (lastPaidAmount >= 50 ? "24_Hour_Plan" : "3_Hour_Plan") : "1_Hour_Plan";
                        await api.write('/ip/hotspot/user/add', [
                            `=name=${subData.phoneNumber}`, `=password=${subData.phoneNumber}`, `=profile=${dynamicProfile}`, `=comment=AutoReconnect_${cleanMac}`
                        ]);
                        await api.close();
                    } catch (routerErr) {
                        console.error("Autologin routing failure:", routerErr.message);
                    }
                }
            }
            return res.status(200).json({ 
                success: true, 
                phoneNumber: subData.phoneNumber, 
                message: "Valid session verified. Connecting automatically." 
            });
        }

        return res.status(401).json({ error: "Active package validity window has expired." });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

// ====================================================================
// VERIFY EXPLICIT M-PESA RECONNECT TRANSACTIONS
// ====================================================================
app.post('/api/hotspot/reconnect-by-code', async (req, res) => {
    const { mpesaCode, routerId, macAddress } = req.body;
    
    if (!mpesaCode || !routerId) {
        return res.status(400).json({ error: "Missing M-Pesa reference code configuration metrics." });
    }

    const cleanCode = mpesaCode.trim().toUpperCase();

    try {
        // FIX 3: Search both 'transactions' and 'global_transactions'
        let transactionDoc = await db.collection('transactions').doc(cleanCode).get();
        if (!transactionDoc.exists) {
            transactionDoc = await db.collection('global_transactions').doc(cleanCode).get();
        }
        
        if (!transactionDoc.exists) {
            return res.status(404).json({ error: "Invalid M-Pesa transaction token code provided." });
        }

        const txData = transactionDoc.data();
        
        const purchaseTime = new Date(txData.timestamp || txData.processedAt || txData.createdAt);
        const elapsedMinutes = (new Date() - purchaseTime) / 60000;
        
        const packageDurationHours = Number(txData.durationHours || 1); 
        const maxValidityMinutes = packageDurationHours * 60;

        if (elapsedMinutes >= maxValidityMinutes) {
            return res.status(410).json({ error: "The transaction pass code for this package configuration has expired." });
        }

        const routerDoc = await db.collection('routers').doc(routerId).get();
        if (routerDoc.exists) {
            const rData = routerDoc.data();
            if (rData.routerIp && rData.routerUser && rData.routerPassword) {
                try {
                    const client = getRouterClient(rData);
                    const api = await client.connect();
                    
                    const profileName = txData.profileName || "1_Hour_Plan";
                    const fallbackUser = txData.customerPhone || txData.phoneNumber || "HotspotUser";

                    await api.write('/ip/hotspot/user/add', [
                        `=name=${fallbackUser}`, 
                        `=password=${fallbackUser}`, 
                        `=profile=${profileName}`, 
                        `=comment=CodeReconnect_${cleanCode}`
                    ]);
                    await api.close();
                } catch (routerErr) {
                    console.error("Router connection node synchronization drop:", routerErr.message);
                }
            }
        }

        return res.status(200).json({
            success: true,
            message: "M-Pesa transaction reference authenticated successfully. Reconnecting pipeline."
        });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ====================================================================
// 1. FETCH DYNAMIC REWARD TIERS (FIRESTORE BASED)
// ====================================================================
app.get('/api/portal/rewards-tiers', async (req, res) => {
    const { ispId } = req.query;
    if (!ispId) return res.status(400).json({ error: "Missing ISP parameter" });

    try {
        // Fetch custom point exchange configurations created by the ISP
        const tiersSnapshot = await db.collection('routers').doc(ispId).collection('rewardTiers').orderBy('pointsRequired', 'asc').get();
        const tiers = [];
        tiersSnapshot.forEach(doc => {
            tiers.push({ id: doc.id, ...doc.data() });
        });
        
        return res.status(200).json(tiers);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ====================================================================
// 2. CHECK WALLET POINTS BY PHONE NUMBER (REAL DATA LOOKUP)
// ====================================================================
app.get('/api/portal/check-points', async (req, res) => {
    const { phoneNumber } = req.query;
    if (!phoneNumber) return res.status(400).json({ error: "Phone number required" });

    try {
        const subscriberDoc = await db.collection('subscribers').where('phoneNumber', '==', phoneNumber.trim()).get();
        if (subscriberDoc.empty) {
            return res.status(200).json({ points: 0, message: "No rewards account found for this number yet." });
        }
        
        const data = subscriberDoc.docs[0].data();
        return res.status(200).json({ points: data.loyaltyPoints || 0 });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ====================================================================
// 3. COMBINED RECONNECT ENGINE (MAC SYNC WITH M-PESA FALLBACK TRACING)
// ====================================================================
app.post('/api/hotspot/reconnect-verify', async (req, res) => {
    const { macAddress, routerId, mpesaCode } = req.body;
    if (!routerId) return res.status(400).json({ error: "Missing Router ID context." });

    try {
        // METHOD A: If an M-Pesa code is sent, verify the transaction token directly
        if (mpesaCode) {
            const cleanCode = mpesaCode.trim().toUpperCase();
            const txDoc = await db.collection('transactions').doc(cleanCode).get();
            
            if (!txDoc.exists) return res.status(404).json({ error: "Invalid M-Pesa transaction token code." });
            const txData = txDoc.data();

            // Provision user session on Mikrotik
            const routerDoc = await db.collection('routers').doc(routerId).get();
            if (routerDoc.exists) {
                const rData = routerDoc.data();
                const client = getRouterClient(rData);
                const api = await client.connect();
                await api.write('/ip/hotspot/user/add', [
                    `=name=${txData.phoneNumber}`, `=password=${txData.phoneNumber}`, `=profile=${txData.profileName || '1_Hour_Plan'}`, `=comment=CodeSync_${cleanCode}`
                ]);
                await api.close();
            }
            return res.status(200).json({ success: true, message: "Transaction token authorized! Device is now online." });
        }

        // METHOD B: Auto-reconnect via MAC Address timeline parameters
        if (macAddress) {
            const cleanMac = macAddress.toLowerCase().replace(/[^a-f0-9]/g, '');
            const subDoc = await db.collection('subscribers').doc(cleanMac).get();
            
            if (!subDoc.exists) {
                return res.status(404).json({ fallbackRequired: true, error: "No active device session found. Please use your M-Pesa code." });
            }

            const subData = subDoc.data();
            const diffInMinutes = (new Date() - new Date(subData.lastActiveTimestamp)) / 60000;
            const lastPaidAmount = subData.lastActivePackage || 0;
            let validityWindow = lastPaidAmount >= 50 ? 1440 : (lastPaidAmount >= 20 ? 180 : 60);

            if (diffInMinutes < validityWindow) {
                const routerDoc = await db.collection('routers').doc(routerId).get();
                if (routerDoc.exists) {
                    const rData = routerDoc.data();
                    const client = getRouterClient(rData);
                    const api = await client.connect();
                    let dynamicProfile = lastPaidAmount >= 20 ? (lastPaidAmount >= 50 ? "24_Hour_Plan" : "3_Hour_Plan") : "1_Hour_Plan";
                    await api.write('/ip/hotspot/user/add', [
                        `=name=${subData.phoneNumber}`, `=password=${subData.phoneNumber}`, `=profile=${dynamicProfile}`, `=comment=AutoMac_${cleanMac}`
                    ]);
                    await api.close();
                }
                return res.status(200).json({ success: true, message: "Valid active session found! Connecting automatically..." });
            }
            return res.status(401).json({ fallbackRequired: true, error: "Active session timeline expired. Please input your payment code." });
        }

        return res.status(400).json({ error: "No query parameters specified." });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ====================================================================
// SMART TV / GAME CONSOLE BRIDGING ENGINE
// ====================================================================

app.post('/api/hotspot/register-tv', async (req, res) => {
    // 1. Destructure with fallback to support both 'tvMacAddress' and 'targetMac'
    const { routerId, tvMacAddress, targetMac, comment } = req.body;
    const rawMac = tvMacAddress || targetMac;

    if (!routerId || !rawMac) {
        return res.status(400).json({ 
            success: false, 
            error: "Missing required setup parameters (routerId or MAC address)." 
        });
    }

    // 2. Clean and format MAC Address strictly (AA:BB:CC:DD:EE:FF)
    const cleanTvMac = rawMac.toUpperCase().replace(/[^A-F0-9]/g, '').replace(/(.{2})(?=.)/g, '$1:');
    
    if (cleanTvMac.length !== 17) {
        return res.status(400).json({ success: false, error: "Invalid MAC address format." });
    }

    let api = null;

    try {
        const routerDoc = await db.collection('routers').doc(routerId).get();
        if (!routerDoc.exists) {
            return res.status(404).json({ success: false, error: "Router node path not found." });
        }
        
        const routerData = routerDoc.data();
        const client = getRouterClient(routerData);
        api = await client.connect();

        // 3. Check if an IP binding already exists for this MAC address
        const existingBindings = await api.write('/ip/hotspot/ip-binding/print', [
            `?.mac-address=${cleanTvMac}`
        ]);

        if (existingBindings && existingBindings.length > 0) {
            // Update existing binding to bypassed status
            const bindingId = existingBindings[0]['.id'];
            await api.write('/ip/hotspot/ip-binding/set', [
                `=.id=${bindingId}`,
                `=type=bypassed`,
                `=comment=${comment || 'SmartTV Setup Bypass (Updated)'}`
            ]);
        } else {
            // Create brand new IP binding
            await api.write('/ip/hotspot/ip-binding/add', [
                `=mac-address=${cleanTvMac}`,
                `=type=bypassed`,
                `=comment=${comment || 'SmartTV Setup Bypass'}`
            ]);
        }

        return res.status(200).json({ 
            success: true, 
            message: `Appliance MAC (${cleanTvMac}) bypassed successfully!` 
        });

    } catch (error) {
        console.error("Smart TV Registration Error:", error);
        return res.status(500).json({ 
            success: false, 
            error: error.message || "Failed to provision hardware bypass on router." 
        });
    } finally {
        // Ensure connection is safely closed regardless of outcome
        if (api) {
            try {
                await api.close();
            } catch (closeErr) {
                console.error("Error closing router socket connection:", closeErr);
            }
        }
    }
});

// ====================================================================
// HOTSPOT ENGINE: SESSIONS & LIVE DISCONNECTS
// ====================================================================

app.get('/api/hotspot/active-sessions', async (req, res) => {
    const { routerId } = req.query;
    if (!routerId) return res.status(400).json({ error: "Missing active router parameters." });

    try {
        const routerDoc = await db.collection('routers').doc(routerId).get();
        if (!routerDoc.exists) return res.status(404).json({ error: "Target node not registered." });
        const routerData = routerDoc.data();
        
        const client = getRouterClient(routerData);
        const api = await client.connect();
        const activeSessions = await api.write('/ip/hotspot/active/print');
        await api.close();

        const standardized = activeSessions.map(s => ({
            id: s['.id'],
            user: s.user || 'Unknown',
            address: s.address || '0.0.0.0',
            macAddress: s['mac-address'] || '00:00:00:00:00:00',
            uptime: s.uptime || '00:00:00',
            bytesIn: parseInt(s['bytes-in'] || 0, 10),
            bytesOut: parseInt(s['bytes-out'] || 0, 10)
        }));

        return res.status(200).json(standardized);
    } catch (error) {
        console.error("Session fetching error logs context:", error.message);
        return res.status(200).json([]);
    }
});

app.post('/api/hotspot/disconnect', async (req, res) => {
    const { routerId, username } = req.body;
    if (!routerId || !username) return res.status(400).json({ error: "Missing required identification keys." });

    try {
        const routerDoc = await db.collection('routers').doc(routerId).get();
        if (!routerDoc.exists) return res.status(404).json({ error: "Router record absent." });
        const routerData = routerDoc.data();

        const client = getRouterClient(routerData);
        const api = await client.connect();
        const items = await api.write('/ip/hotspot/active/print', [`.query=user=${username}`]);
        if(items.length > 0) {
            await api.write('/ip/hotspot/active/remove', [`.id=${items[0]['.id']}`]);
        }
        await api.close();

        return res.status(200).json({ success: true, message: "Subscriber kicked from network interface." });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ====================================================================
// PPPOE ENGINE: MANAGING BROADBAND SUBSCRIBERS
// ====================================================================

// Create PPPoE Secret on MikroTik + Sync to Database
app.post('/api/pppoe/create-secret', async (req, res) => {
    const { routerId, username, password, profile, ispId } = req.body;
    
    if (!routerId || !username || !password) {
        return res.status(400).json({ success: false, error: "Missing required PPPoE fields." });
    }

    let api = null;
    try {
        // 1. Fetch router doc by ID or name
        let routerDoc = await db.collection('routers').doc(routerId).get();
        let routerData = routerDoc.exists ? routerDoc.data() : null;

        if (!routerData) {
            const snapshot = await db.collection('routers').where('name', '==', routerId).limit(1).get();
            if (!snapshot.empty) routerData = snapshot.docs[0].data();
        }

        if (!routerData) {
            return res.status(404).json({ success: false, error: `Router '${routerId}' configuration not found.` });
        }

        // 2. MOCK MODE CHECK: If IP is dummy/unconfigured, skip hardware TCP connection
        const isTestMode = !routerData.routerIp || routerData.routerIp === '0.0.0.0' || routerData.routerIp === '127.0.0.1';

        if (!isTestMode) {
            // Live Physical Router Execution
            const client = getRouterClient(routerData);
            api = await client.connect();

            await api.write('/ppp/secret/add', [
                `=name=${username}`,
                `=password=${password}`,
                `=profile=${profile || 'default'}`,
                `=service=pppoe`
            ]);
        } else {
            console.log(`[TEST MODE] Bypassed physical MikroTik API connection for subscriber '${username}' on router '${routerId}'`);
        }

        // 3. Persist in Firestore subscribers collection
        await db.collection('subscribers').add({
            ispId: ispId || routerData.ispId || 'default_isp',
            routerId: routerId,
            username: username,
            type: 'pppoe',
            profile: profile || 'default',
            status: 'active',
            createdAt: new Date()
        });

        return res.status(200).json({ success: true, mock: isTestMode });

    } catch (error) {
        console.error("PPPoE secret creation error:", error);
        return res.status(500).json({ success: false, error: error.message });
    } finally {
        if (api && typeof api.close === 'function') {
            try { await api.close(); } catch(e) {}
        }
    }
});

// Fetch Secrets from MikroTik Router or Firestore Fallback
app.get('/api/pppoe/secrets', async (req, res) => {
    const { routerId } = req.query;
    if (!routerId) return res.status(400).json([]);

    let api = null;
    try {
        // 1. Fetch router doc by ID or name
        let routerDoc = await db.collection('routers').doc(routerId).get();
        let routerData = routerDoc.exists ? routerDoc.data() : null;

        if (!routerData) {
            const snapshot = await db.collection('routers').where('name', '==', routerId).limit(1).get();
            if (!snapshot.empty) routerData = snapshot.docs[0].data();
        }

        const isTestMode = !routerData || !routerData.routerIp || routerData.routerIp === '0.0.0.0';

        // 2. MOCK MODE / FALLBACK: Read directly from Firestore 'subscribers'
        if (isTestMode) {
            const subSnapshot = await db.collection('subscribers')
                .where('routerId', '==', routerId)
                .get();

            const mockSecrets = subSnapshot.docs.map(doc => {
                const data = doc.data();
                return {
                    id: doc.id,
                    name: data.username,
                    profile: data.profile || 'default',
                    disabled: data.status === 'suspended' ? "true" : "false",
                    remoteAddress: '192.168.88.100 (Simulated)'
                };
            });

            return res.status(200).json(mockSecrets);
        }

        // 3. Live Hardware Execution
        const client = getRouterClient(routerData);
        api = await client.connect();
        const secrets = await api.write('/ppp/secret/print');

        const formattedSecrets = (secrets || []).map(s => ({
            id: s['.id'],
            name: s.name,
            profile: s.profile || 'default',
            disabled: s.disabled || "false",
            remoteAddress: s['remote-address'] || 'Dynamic Allocation'
        }));

        return res.status(200).json(formattedSecrets);

    } catch (error) {
        console.error("Fetch secrets API error:", error.message);
        return res.status(200).json([]);
    } finally {
        if (api && typeof api.close === 'function') {
            try { await api.close(); } catch(e) {}
        }
    }
});

// ====================================================================
// DHCP ENGINE: STATIC LEASE SUBSYSTEM MANAGEMENT
// ====================================================================

app.post('/api/dhcp/create-lease', async (req, res) => {
    const { routerId, macAddress, ipAddress, fullName, phone, packageId, plan, ipType, email, location, comment, ispId } = req.body;
    
    const customerName = fullName || comment || 'AudiSpot Static Customer';
    const selectedPackage = packageId || plan || 'Default Package';

    if (!routerId) {
        return res.status(400).json({ success: false, error: "Missing required routerId field." });
    }

    let api = null;
    try {
        let routerDoc = await db.collection('routers').doc(routerId).get();
        let routerData = routerDoc.exists ? routerDoc.data() : null;

        if (!routerData) {
            const snapshot = await db.collection('routers').where('name', '==', routerId).limit(1).get();
            if (!snapshot.empty) routerData = snapshot.docs[0].data();
        }

        if (!routerData) {
            return res.status(404).json({ success: false, error: `Router '${routerId}' configuration not found.` });
        }

        const isTestMode = !routerData.routerIp || routerData.routerIp === '0.0.0.0' || routerData.routerIp === '127.0.0.1';

        const finalMac = macAddress || `02:00:00:${Math.floor(Math.random()*89+10)}:${Math.floor(Math.random()*89+10)}:${Math.floor(Math.random()*89+10)}`;
        const finalIp = ipAddress || `192.168.88.${Math.floor(Math.random()*150+50)}`;

        if (!isTestMode) {
            const client = getRouterClient(routerData);
            api = await client.connect();

            await api.write('/ip/dhcp-server/lease/add', [
                `=mac-address=${finalMac}`,
                `=address=${finalIp}`,
                `=comment=${customerName} - ${phone || ''}`
            ]);
        } else {
            console.log(`[TEST MODE] Bypassed physical MikroTik API for static lease '${customerName}' on router '${routerId}'`);
        }

        // Persist Subscriber with mapped Package Name
        await db.collection('subscribers').add({
            ispId: ispId || routerData.ispId || 'default_isp',
            routerId: routerId,
            fullName: customerName,
            phone: phone || '',
            packageName: selectedPackage,
            ipType: ipType || 'private',
            email: email || '',
            location: location || '',
            macAddress: finalMac,
            ipAddress: finalIp,
            type: 'static-dhcp',
            status: 'active',
            createdAt: new Date()
        });

        return res.status(200).json({ success: true, mock: isTestMode });

    } catch (error) {
        console.error("Static DHCP creation error:", error);
        return res.status(500).json({ success: false, error: error.message });
    } finally {
        if (api && typeof api.close === 'function') {
            try { await api.close(); } catch(e) {}
        }
    }
});

// Fetch Static Leases from MikroTik Router or Firestore Fallback
app.get('/api/dhcp/leases', async (req, res) => {
    const { routerId } = req.query;
    if (!routerId) return res.status(200).json([]);

    let api = null;
    try {
        // 1. Fetch router doc by ID or name
        let routerDoc = await db.collection('routers').doc(routerId).get();
        let routerData = routerDoc.exists ? routerDoc.data() : null;

        if (!routerData) {
            const snapshot = await db.collection('routers').where('name', '==', routerId).limit(1).get();
            if (!snapshot.empty) routerData = snapshot.docs[0].data();
        }

        const isTestMode = !routerData || !routerData.routerIp || routerData.routerIp === '0.0.0.0' || routerData.routerIp === '127.0.0.1';

        // 2. MOCK MODE / FALLBACK: Read from Firestore 'subscribers'
        if (isTestMode) {
            const subSnapshot = await db.collection('subscribers')
                .where('routerId', '==', routerId)
                .where('type', '==', 'static-dhcp')
                .get();

            const mockLeases = subSnapshot.docs.map(doc => {
                const data = doc.data();
                return {
                    id: doc.id,
                    comment: data.fullName || data.comment || 'Static Customer',
                    macAddress: data.macAddress || 'Auto-assigned',
                    address: data.ipAddress || 'Dynamic Allocation',
                    packageName: data.packageName || data.plan || 'Default Package',
                    plan: data.packageName || data.plan || 'Default Package',
                    status: data.status || 'active'
                };
            });

            return res.status(200).json(mockLeases);
        }

        // 3. Live Hardware Execution
        const client = getRouterClient(routerData);
        api = await client.connect();

        const leases = await api.write('/ip/dhcp-server/lease/print');

        const staticLeases = (leases || [])
            .filter(l => String(l.dynamic) === 'false' || !l.dynamic)
            .map(l => ({
                id: l['.id'],
                macAddress: l['mac-address'],
                address: l.address,
                comment: l.comment || 'Permanent Hardware Binding',
                status: l.disabled === 'true' || l.disabled === true ? 'suspended' : 'active'
            }));

        return res.status(200).json(staticLeases);

    } catch (err) {
        console.error("Fetch DHCP leases API error:", err.message);
        return res.status(200).json([]);
    } finally {
        if (api && typeof api.close === 'function') {
            try { await api.close(); } catch(e) {}
        }
    }
});

// Setup Static Subnet & Optional DHCP Pool on MikroTik Router
app.post('/api/dhcp/setup-subnet', async (req, res) => {
    const { routerId, subnet, gateway, bridgeInterface, runDhcp, ispId } = req.body;

    if (!routerId || !subnet) {
        return res.status(400).json({ success: false, error: "Router and Subnet (CIDR) are required." });
    }

    let api = null;
    try {
        let routerDoc = await db.collection('routers').doc(routerId).get();
        let routerData = routerDoc.exists ? routerDoc.data() : null;

        if (!routerData) {
            const snapshot = await db.collection('routers').where('name', '==', routerId).limit(1).get();
            if (!snapshot.empty) routerData = snapshot.docs[0].data();
        }

        if (!routerData) {
            return res.status(404).json({ success: false, error: "Router configuration not found." });
        }

        const isTestMode = !routerData.routerIp || routerData.routerIp === '0.0.0.0' || routerData.routerIp === '127.0.0.1';

        // Extract subnet prefix dynamically (e.g. "10.20.0.0/24" -> prefix "24")
        const cidrMatch = subnet.match(/\/(\d+)$/);
        const prefix = cidrMatch ? cidrMatch[1] : '24';
        const gwAddress = gateway || subnet.replace(/\.0\/\d+$/, '.1');

        if (!isTestMode) {
            const client = getRouterClient(routerData);
            api = await client.connect();

            // 1. Add Gateway IP Address to interface (Safely catch duplicate errors)
            try {
                await api.write('/ip/address/add', [
                    `=address=${gwAddress}/${prefix}`,
                    `=interface=${bridgeInterface || 'bridge'}`
                ]);
            } catch (ipErr) {
                console.warn("IP Address setup warning (may already exist):", ipErr.message);
            }

            // 2. Optionally configure DHCP Server Pool
            if (runDhcp) {
                const poolName = `static_pool_${routerId}`;
                const poolRange = subnet.replace(/\.0\/\d+$/, '.10-.250');

                try {
                    await api.write('/ip/pool/add', [
                        `=name=${poolName}`,
                        `=ranges=${poolRange}`
                    ]);
                } catch (poolErr) {
                    console.warn("Pool creation warning:", poolErr.message);
                }

                try {
                    await api.write('/ip/dhcp-server/add', [
                        `=name=dhcp_static_${routerId}`,
                        `=interface=${bridgeInterface || 'bridge'}`,
                        `=address-pool=${poolName}`,
                        `=disabled=no`
                    ]);
                } catch (dhcpErr) {
                    console.warn("DHCP server creation warning:", dhcpErr.message);
                }
            }
        }

        // Save setup record in Firestore
        await db.collection('static_subnets').add({
            ispId: ispId || routerData.ispId || 'default_isp',
            routerId,
            subnet,
            gateway: gwAddress,
            bridgeInterface: bridgeInterface || 'bridge',
            createdAt: new Date()
        });

        return res.status(200).json({ success: true, mock: isTestMode });

    } catch (error) {
        console.error("Setup subnet error:", error);
        return res.status(500).json({ success: false, error: error.message });
    } finally {
        if (api && typeof api.close === 'function') {
            try { await api.close(); } catch(e) {}
        }
    }
});

// ====================================================================
// SYSTEM COMPONENT: SECURE SYSTEM ACCESS VOUCHERS API
// ====================================================================

app.get('/api/vouchers', async (req, res) => {
    const ispId = req.query.ispId || 'default_isp';
    try {
        const snapshot = await db.collection('isp_vouchers')
            .where('ispId', '==', ispId)
            .get();
        const vouchers = [];
        snapshot.forEach(doc => {
            vouchers.push({ id: doc.id, ...doc.data() });
        });
        vouchers.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return res.status(200).json(vouchers);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

app.post('/api/vouchers/generate', async (req, res) => {
    const { ispId, packageId, count, codeLength } = req.body;
    try {
        const pkgDoc = await db.collection('isp_packages').doc(packageId).get();
        if (!pkgDoc.exists) {
            return res.status(400).json({ success: false, error: "The selected custom package configuration rules do not exist." });
        }
        
        const pkgData = pkgDoc.data();
        const packageName = pkgData.packageName || "Custom Tier";
        const price = pkgData.price || 0;
        const duration = pkgData.duration || 0;

        const batch = db.batch();
        const collectionRef = db.collection('isp_vouchers');
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; 
        
        const batchCount = Math.min(Math.max(count || 10, 1), 100);
        const len = codeLength || 8;

        for (let i = 0; i < batchCount; i++) {
            let generatedCode = '';
            for (let j = 0; j < len; j++) {
                generatedCode += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            
            const docRef = collectionRef.doc();
            batch.set(docRef, {
                ispId: ispId || 'default_isp',
                packageId,
                packageName,
                price: parseFloat(price),
                duration: parseInt(duration),
                code: `AUDI-${generatedCode}`,
                status: 'Active',
                createdAt: new Date().toISOString()
            });
        }
        
        await batch.commit();
        return res.status(200).json({ success: true, message: "Batch generation complete." });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

app.post('/api/vouchers/redeem', async (req, res) => {
    const { code, macAddress, ispId } = req.body;

    try {
        // 1. Find voucher in Firestore
        const snapshot = await db.collection('isp_vouchers')
            .where('ispId', '==', ispId || 'default_isp')
            .where('code', '==', code.trim())
            .get();

        if (snapshot.empty) {
            return res.status(404).json({ success: false, message: "Invalid voucher code." });
        }

        const voucherDoc = snapshot.docs[0];
        const voucher = voucherDoc.data();

        // 2. Check if already used
        if (voucher.status !== 'Active') {
            return res.status(400).json({ success: false, message: "This voucher has already been used." });
        }

        // 3. Mark voucher as used
        await voucherDoc.ref.update({
            status: 'Used',
            usedByMac: macAddress,
            usedAt: new Date().toISOString()
        });

        // 4. Return success along with the package constraints for router login
        return res.status(200).json({
            success: true,
            message: "Voucher activated successfully!",
            package: {
                duration: voucher.duration,
                packageName: voucher.packageName
            }
        });

    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/vouchers/bulk-delete', async (req, res) => {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) {
        return res.status(400).json({ success: false, error: "Invalid identity array sequence profiles parameters." });
    }
    
    try {
        const batch = db.batch();
        const collectionRef = db.collection('isp_vouchers');
        
        ids.forEach(id => {
            const docRef = collectionRef.doc(id);
            batch.delete(docRef);
        });
        
        await batch.commit();
        return res.status(200).json({ success: true, message: "Bulk records purged successfully." });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ====================================================================
// TENANT CONFIGURATION: CAPTIVE PORTAL CUSTOMIZER ENDPOINTS
// ====================================================================

app.get('/api/portal/design', async (req, res) => {
    const ispId = req.query.ispId || 'default_isp';
    try {
        // Fetch both documents concurrently
        const portalDocRef = db.collection('isp_portals').doc(ispId);
        const settingsDocRef = db.collection('settings').doc(ispId);

        const [portalDoc, settingsDoc] = await Promise.all([
            portalDocRef.get(),
            settingsDocRef.get()
        ]);

        // Base defaults for portal design
        let portalData = {
            brandName: "AudiSpot Wireless",
            welcomeGreeting: "Enter verification parameters to connect.",
            supportContact: "0700000000",
            accentColor: "#4f46e5",
            earnPoints: 10,
            redeemPoints: 100,
            rewardTiers: [],
            reconnectMsg: "Click button below to search active sessions.",
            tvSetup: "1. Locate MAC address of TV\n2. Submit register address\n3. TV is authorized automatically.",
            successTitle: "Welcome Online!",
            successSub: "Your account connection rules are fully operational.",
            successBtn: "Proceed to Browsing"
        };

        if (portalDoc.exists) {
            portalData = portalDoc.data();
        }

        // Pull saved settings or fall back to default URL
        const settingsData = settingsDoc.exists ? settingsDoc.data() : {};
        const redirectUrl = settingsData.redirectUrl || 'https://audispot.audiory.site/';

        // Merge design settings with system branding redirect URL
        return res.status(200).json({
            ...portalData,
            redirectUrl: redirectUrl
        });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

app.post('/api/portal/design/save', async (req, res) => {
    const { 
        ispId, brandName, welcomeGreeting, supportContact, accentColor,
        earnPoints, redeemPoints, rewardTiers, reconnectMsg, tvSetup,
        successTitle, successSub, successBtn
    } = req.body;

    try {
        const targetTenant = ispId || 'default_isp';
        
        // Safely validate and map the incoming array elements to prevent database corruption
        const sanitizedTiers = Array.isArray(rewardTiers) ? rewardTiers.map(tier => ({
            pointsRequired: parseInt(tier.pointsRequired) || 0,
            mikrotikProfile: String(tier.mikrotikProfile || '').trim(),
            displayName: String(tier.displayName || '').trim()
        })) : [];

        await db.collection('isp_portals').doc(targetTenant).set({
            brandName,
            welcomeGreeting,
            supportContact,
            accentColor,
            earnPoints: parseInt(earnPoints) || 10,
            redeemPoints: parseInt(redeemPoints) || 100,
            rewardTiers: sanitizedTiers, // Added to persistence profile write payload
            reconnectMsg,
            tvSetup,
            successTitle,
            successSub,
            successBtn,
            lastModified: new Date().toISOString()
        }, { merge: true });

        return res.status(200).json({ success: true, message: "Captive Portal design synchronized successfully." });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ====================================================================
// EXPENSES SYSTEM: CREATE, READ, & DELETE EXPENSE RECORDS
// ====================================================================

app.get('/api/expenses', async (req, res) => {
    const ispId = req.query.ispId || 'default_isp';

    try {
        // Query matching documents WITHOUT orderBy to avoid Firestore Index errors
        const snapshot = await db.collection('isp_expenses')
            .where('ispId', '==', ispId)
            .get();

        const expenses = [];

        snapshot.forEach(doc => {
            const data = doc.data();

            expenses.push({
                id: doc.id,
                description: data.description || "Uncategorized Expense",
                amount: data.amount || 0,
                category: data.category || "General",
                date: data.date || new Date().toISOString(),
                createdAt: data.createdAt || null
            });
        });

        expenses.sort((a, b) => {
            const dateA = new Date(a.createdAt || 0);
            const dateB = new Date(b.createdAt || 0);
            return dateB - dateA;
        });

        return res.status(200).json(expenses);

    } catch (err) {
        console.error("Expenses fetch failure:", err);
        return res.status(500).json({
            error: err.message
        });
    }
});

app.post('/api/expenses/create', async (req, res) => {
    const { ispId, description, amount, category, date } = req.body;
    
    if (!description || amount === undefined || isNaN(parseFloat(amount)) || !category) {
        return res.status(400).json({ success: false, error: "Missing required configuration fields." });
    }
    
    try {
        const newExpenseRef = db.collection('isp_expenses').doc();
        await newExpenseRef.set({
            ispId: ispId || "default_isp",
            description,
            amount: parseFloat(amount),
            category,
            date: date || new Date().toISOString().split('T')[0],
            createdAt: new Date().toISOString()
        });
        
        return res.status(200).json({ success: true, id: newExpenseRef.id });
    } catch (error) {
        console.error("Failed to create expense:", error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/expenses/delete', async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, error: "Missing document unique identity." });
    
    try {
        await db.collection('isp_expenses').doc(id).delete();
        return res.status(200).json({ success: true, message: "Expense record scrubbed." });
    } catch (error) {
        console.error("Failed to delete expense:", error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ====================================================================
// ANALYTICS ENGINE: LIVE STATISTICAL COMPILING
// ====================================================================

app.get('/api/isp/analytics/:ispId', async (req, res) => {
    const { ispId } = req.params;
    const targetTenant = ispId || "default_isp";
    
    try {
        // 1. Fetch Routers
        const routersSnapshot = await db.collection('routers')
            .where('ispId', '==', targetTenant)
            .get();
        const routerCount = routersSnapshot.size;

        // 2. Query Transactions directly by ispId (matching Dashboard logic)
        let txSnapshot = await db.collection('global_transactions')
            .where('ispId', '==', targetTenant)
            .get();

        // Fallback for snake_case field naming if any
        if (txSnapshot.empty) {
            txSnapshot = await db.collection('global_transactions')
                .where('isp_id', '==', targetTenant)
                .get();
        }

        let totalRevenue = 0;
        let transactionCount = 0;
        const revenueOverTime = {};

        txSnapshot.forEach(doc => {
            const data = doc.data();
            const status = (data.status || 'completed').toLowerCase();

            if (status === 'completed' || status === 'success') {
                const amount = parseFloat(data.grossAmount || data.amount) || 0;
                totalRevenue += amount;
                transactionCount++;

                // Process timestamp safely
                const txDate = data.createdAt?.toDate 
                    ? data.createdAt.toDate() 
                    : new Date(data.createdAt || data.processedAt || data.date || Date.now());

                const dayString = txDate.toISOString().split('T')[0];
                revenueOverTime[dayString] = (revenueOverTime[dayString] || 0) + amount;
            }
        });

        // 3. Query Expenses
        let expensesSnapshot = await db.collection('isp_expenses')
            .where('ispId', '==', targetTenant)
            .get();

        if (expensesSnapshot.empty) {
            expensesSnapshot = await db.collection('isp_expenses')
                .where('isp_id', '==', targetTenant)
                .get();
        }

        let totalExpenses = 0;
        const expensesByCategory = {};

        expensesSnapshot.forEach(doc => {
            const data = doc.data();
            const amount = parseFloat(data.amount) || 0;
            totalExpenses += amount;

            const category = data.category || "General";
            expensesByCategory[category] = (expensesByCategory[category] || 0) + amount;
        });

        // 4. Query Subscribers (Check subscribers or hotspot users)
        let subscribersSnapshot = await db.collection('subscribers')
            .where('ispId', '==', targetTenant)
            .get();

        if (subscribersSnapshot.empty) {
            subscribersSnapshot = await db.collection('subscribers')
                .where('isp_id', '==', targetTenant)
                .get();
        }

        let totalSubscribers = subscribersSnapshot.size;

        // Fallback: Check used vouchers / active sessions if subscribers collection is empty
        if (totalSubscribers === 0) {
            const activeVouchers = await db.collection('isp_vouchers')
                .where('ispId', '==', targetTenant)
                .where('status', '==', 'Used')
                .get();
            totalSubscribers = activeVouchers.size;
        }

        const netEarnings = Math.max(0, totalRevenue - totalExpenses);

        const chartTimeline = Object.keys(revenueOverTime)
            .sort()
            .map(date => ({ date, amount: revenueOverTime[date] }));

        return res.status(200).json({
            success: true,
            summary: {
                totalRevenue,
                totalExpenses,
                netEarnings,
                totalSubscribers,
                totalRouters: routerCount,
                transactionCount
            },
            expensesByCategory,
            chartTimeline
        });
    } catch (error) {
        console.error("Analytics compile error:", error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// FIXED: Handles withdrawal records correctly against 'withdrawals' and refunds to 'isp_users'
app.post('/api/mpesa/b2c-callback', async (req, res) => {
    const { payoutId } = req.query;
    const { Result } = req.body;

    try {
        const payoutRef = db.collection('withdrawals').doc(payoutId);
        const payoutDoc = await payoutRef.get();

        if (!payoutDoc.exists) {
            return res.json({ ResultCode: 1, ResultDesc: "Payout record not found" });
        }

        const { ispId, amount } = payoutDoc.data();

        if (Result.ResultCode === 0) {
            await payoutRef.update({
                status: 'completed',
                mpesaReceipt: Result.ResultParameters.ResultParameter.find(p => p.Key === "TransactionReceipt").Value,
                completedAt: new Date().toISOString()
            });
        } else {
            // FIXED: Target 'isp_users' collection to execute the transaction refund properly
            const ispRef = db.collection('isp_users').doc(ispId);
            await db.runTransaction(async (transaction) => {
                const ispDoc = await transaction.get(ispRef);
                const currentBalance = ispDoc.exists ? (ispDoc.data().walletBalance || 0) : 0;
                transaction.update(ispRef, { walletBalance: currentBalance + amount });
                transaction.update(payoutRef, { status: 'failed', errorCode: Result.ResultCode, errorDesc: Result.ResultDesc });
            });
        }

        return res.json({ ResultCode: 0, ResultDesc: "Callback received and processed" });
    } catch (error) {
        console.error("B2C Callback error:", error.message);
        return res.status(500).json({ error: error.message });
    }
});

// ====================================================================
// SETTINGS MIDDLEWARE-DRIVEN ENDPOINTS
// ====================================================================

app.get('/api/settings', async (req, res) => {
    const ispId = req.query.ispId || 'default_isp';
    const email = req.query.email || '';
    const name = req.query.name || '';
    
    try {
        const settings = await getOrCreateSettings(req.db, ispId, email, name);
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/settings/account', async (req, res) => {
    const ispId = req.query.ispId || 'default_isp';
    const { accountName, accountEmail, accountCompany } = req.body;
    try {
        await req.db.collection('settings').doc(ispId).set({
            accountName,
            accountEmail,
            accountCompany
        }, { merge: true });
        res.sendStatus(200);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/settings/pppoe', async (req, res) => {
    const ispId = req.query.ispId || 'default_isp';
    const { defaultPppoePassword } = req.body;
    try {
        await req.db.collection('settings').doc(ispId).set({ defaultPppoePassword }, { merge: true });
        res.sendStatus(200);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/settings/branding', async (req, res) => {
    const ispId = req.query.ispId || 'default_isp';
    const { brandName, serverIp, supportPhone, redirectUrl } = req.body;

    // Use provided redirectUrl or fall back to the default portal
    const finalRedirectUrl = redirectUrl?.trim() || 'https://audispot.audiory.site/';

    try {
        await req.db.collection('settings').doc(ispId).set({
            brandName,
            serverIp,
            supportPhone,
            redirectUrl: finalRedirectUrl,
            updatedAt: new Date()
        }, { merge: true });

        res.status(200).json({ success: true, redirectUrl: finalRedirectUrl });
    } catch (err) {
        console.error("Error updating branding:", err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/settings/toggle-sms', async (req, res) => {
    const ispId = req.query.ispId || 'default_isp';
    try {
        const settingsRef = req.db.collection('settings').doc(ispId);
        const settingsDoc = await settingsRef.get();
        const currentActiveState = settingsDoc.exists ? settingsDoc.data().smsActive : false;
        
        const payload = { smsActive: !currentActiveState };
        if (!currentActiveState) {
            payload.smsCredits = 10;
        }

        await settingsRef.set(payload, { merge: true });
        res.sendStatus(200);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== TECHNICIAN SECURITY LOGINS ====================

app.post('/api/technicians', async (req, res) => {
    const { name, email, password, ispId } = req.body;
    try {
        const newTechRef = req.db.collection('technicians').doc();
        const techUser = {
            id: newTechRef.id,
            name,
            email,
            password, 
            ispId,
            role: "technician",
            createdAt: new Date().toISOString()
        };
        await newTechRef.set(techUser);
        res.status(201).json(techUser);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/technicians', async (req, res) => {
    const ispId = req.query.ispId || 'default_isp';
    try {
        const snapshot = await req.db.collection('technicians')
            .where('ispId', '==', ispId)
            .orderBy('createdAt', 'desc')
            .get();
            
        const techList = [];
        snapshot.forEach(doc => techList.push(doc.data()));
        res.json(techList);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/technicians/:id', async (req, res) => {
    const techId = req.params.id;
    const ispId = req.query.ispId || 'default_isp';
    try {
        const techRef = req.db.collection('technicians').doc(techId);
        const doc = await techRef.get();
        
        if (!doc.exists || doc.data().ispId !== ispId) {
            return res.status(404).json({ error: "Technician credential payload not located." });
        }
        
        await techRef.delete();
        res.sendStatus(200);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ISP Login Endpoint
app.post('/api/auth/isp-login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ success: false, error: "Email and password are required." });
    }

    try {
        const ispId = email.replace(/[^a-zA-Z0-9]/g, "_");
        const ispDoc = await db.collection('isp_users').doc(ispId).get();

        if (!ispDoc.exists) {
            return res.status(401).json({ success: false, error: "Invalid email or password." });
        }

        const ispData = ispDoc.data();

        // Simple password verification
        if (ispData.password !== password) {
            return res.status(401).json({ success: false, error: "Invalid email or password." });
        }

        // Generate token
        const token = Buffer.from(`${ispId}:${Date.now()}`).toString('base64');

        // Parse Firestore timestamps cleanly
        const createdAt = ispData.createdAt?.toDate ? ispData.createdAt.toDate() : (ispData.createdAt ? new Date(ispData.createdAt) : new Date());
        const expiryDate = ispData.expiryDate?.toDate ? ispData.expiryDate.toDate() : (ispData.expiryDate ? new Date(ispData.expiryDate) : null);

        return res.status(200).json({
            success: true,
            token: token,
            ispId: ispId,
            ispName: ispData.ispName,
            // Pass official timestamps to frontend
            created_at: createdAt.toISOString(),
            expiry_date: expiryDate ? expiryDate.toISOString() : null
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ====================================================================
// MULTI-TENANT ISOLATED PAYMENT HISTORY ENDPOINT (FIXED)
// ====================================================================
app.get('/api/isp/payment-history/:ispId', async (req, res) => {
    const { ispId } = req.params;

    if (!ispId || ispId === 'null' || ispId === 'undefined') {
        return res.status(400).json({ success: false, error: "Invalid ISP Tenant ID provided." });
    }

    try {
        // 1. Fetch ISP User Profile & Settings
        const ispDoc = await db.collection('isp_users').doc(ispId).get();
        const settingsDoc = await db.collection('settings').doc(ispId).get();
        const settings = settingsDoc.exists ? settingsDoc.data() : {};
        const ispData = ispDoc.exists ? ispDoc.data() : {};

        // 2. Discover all Router IDs registered to THIS specific tenant
        const routerDocs = await db.collection('routers').where('ispId', '==', ispId).get();
        const tenantRouterIds = new Set([ispId]);

        routerDocs.forEach(r => {
            tenantRouterIds.add(r.id);
            if (r.data().routerId) tenantRouterIds.add(r.data().routerId);
        });

        // 3. Query transactions for THIS TENANT ONLY
        const rawDocsMap = new Map();
        const collections = ['global_transactions', 'transactions'];

        for (const col of collections) {
            const snapByIsp = await db.collection(col).where('ispId', '==', ispId).get();
            snapByIsp.forEach(d => rawDocsMap.set(d.id, d.data()));

            for (const rId of tenantRouterIds) {
                const snapByRouter = await db.collection(col).where('routerId', '==', rId).get();
                snapByRouter.forEach(d => rawDocsMap.set(d.id, d.data()));
            }
        }

        // 4. Calculate isolated financial metrics with ROBUST DATE PARSING
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() - now.getDay());
        startOfWeek.setHours(0, 0, 0, 0);
        const startOfWeekTime = startOfWeek.getTime();

        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

        let totalTx = 0, completedTx = 0, pendingTx = 0, failedTx = 0;
        let collectedToday = 0, collectedThisWeek = 0, collectedThisMonth = 0, grossEarnedAllTime = 0;

        const transactions = [];

        rawDocsMap.forEach((tx, docId) => {
            totalTx++;

            const rawStatus = String(tx.status || 'SUCCESS').toUpperCase();
            const isSuccess = ['SUCCESS', 'PAID', 'COMPLETED', '0'].includes(rawStatus);
            const isPending = rawStatus === 'PENDING';

            const amount = parseFloat(tx.grossAmount || tx.amount || 0);

            // --- ROBUST DATE PARSER (Handles Firestore Timestamps & Strings) ---
            let txDateObj;
            const rawTime = tx.createdAt || tx.timestamp || tx.date;

            if (rawTime && typeof rawTime.toDate === 'function') {
                // Native Firestore Timestamp
                txDateObj = rawTime.toDate();
            } else if (rawTime && rawTime._seconds) {
                // Serialized Firestore Timestamp
                txDateObj = new Date(rawTime._seconds * 1000);
            } else if (rawTime) {
                // String or numeric epoch
                txDateObj = new Date(rawTime);
            } else {
                txDateObj = new Date();
            }

            // Fallback if Date parsing fails
            if (isNaN(txDateObj.getTime())) {
                txDateObj = new Date();
            }

            const txTime = txDateObj.getTime();
            const isoDateStr = txDateObj.toISOString();

            if (isSuccess) {
                completedTx++;
                grossEarnedAllTime += amount;

                if (txTime >= startOfDay) collectedToday += amount;
                if (txTime >= startOfWeekTime) collectedThisWeek += amount;
                if (txTime >= startOfMonth) collectedThisMonth += amount;
            } else if (isPending) {
                pendingTx++;
            } else {
                failedTx++;
            }

            const customerPhone = tx.phoneNumber || tx.customerPhone || tx.phone || '—';

            transactions.push({
                id: docId,
                date: isoDateStr,
                phone: customerPhone,
                customer: tx.customerName || customerPhone,
                package: tx.profileName || tx.package || `${tx.durationHours || 1} Hr Pass`,
                amount: amount,
                status: isSuccess ? 'completed' : (isPending ? 'pending' : 'failed'),
                receipt: tx.mpesaReceipt || tx.receipt || docId,
                voucher: tx.voucher || '—'
            });
        });

        // Sort descending by date
        transactions.sort((a, b) => new Date(b.date) - new Date(a.date));

        // Resolve normalized Gateway Type
        const rawIntegration = String(settings.mpesaIntegrationType || settings.gatewayType || 'platform').toLowerCase();
        const isDarajaType = rawIntegration.includes('daraja') || settings.tillNumber || settings.mpesaShortcode;
        const normalizedGateway = isDarajaType ? 'daraja' : 'platform';

        return res.status(200).json({
            success: true,
            gatewayType: normalizedGateway,
            tillNumber: settings.tillNumber || settings.mpesaShortcode || '4030905',
            withdrawableBalance: ispData.walletBalance !== undefined ? ispData.walletBalance : grossEarnedAllTime,
            metrics: {
                totalCount: totalTx,
                completedCount: completedTx,
                pendingCount: pendingTx,
                failedCount: failedTx,
                collectedToday: collectedToday,
                collectedThisWeek: collectedThisWeek,
                collectedThisMonth: collectedThisMonth,
                grossEarnedAllTime: grossEarnedAllTime
            },
            transactions: transactions
        });

    } catch (error) {
        console.error("Multi-tenant transaction fetch error:", error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// Self-contained phone number helper
const formatMpesaPhone = (phone) => {
    let cleaned = (phone || '').toString().replace(/\D/g, '');
    if (cleaned.startsWith('0')) {
        cleaned = '254' + cleaned.slice(1);
    } else if (cleaned.startsWith('7') || cleaned.startsWith('1')) {
        cleaned = '254' + cleaned;
    }
    return cleaned;
};

app.post('/api/isp/renew-subscription', async (req, res) => {
    // Prevent browser 304 caching during active polling
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    
    try {
        const { phoneNumber, ispId } = req.body;
        const db = req.db;

        if (!phoneNumber || !ispId) {
            return res.status(400).json({ success: false, error: "Missing phone number or ISP ID." });
        }

        const formattedPhone = formatMpesaPhone(phoneNumber);

        // Fetch router count safely from Firestore
        let routerCount = 0;
        try {
            const routersSnapshot = await db.collection('routers').where('ispId', '==', ispId).get();
            routerCount = routersSnapshot.size;
        } catch (e) {
            console.error("Firestore router lookup error:", e);
        }

        // Default to at least 1 router (KSh 500) if count is 0 so trial users can renew
        const amount = routerCount > 0 ? routerCount * 500 : 500;

        const consumerKey = process.env.MPESA_CONSUMER_KEY;
        const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
        const shortCode = process.env.MPESA_SHORTCODE;
        const passkey = process.env.MPESA_PASSKEY;
        const baseUrl = process.env.SERVER_BASE_URL || "https://audispoty-749056206562.europe-west1.run.app";

        if (!consumerKey || !consumerSecret || !shortCode || !passkey) {
            console.error("Missing M-Pesa Environment Variables!");
            return res.status(500).json({ 
                success: false, 
                error: "M-Pesa credentials not configured on backend." 
            });
        }

        // 1. Get OAuth Token
        const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
        const tokenRes = await axios.get('https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
            headers: { Authorization: `Basic ${auth}` }
        });
        const accessToken = tokenRes.data.access_token;

        // 2. Build Password & Timestamp
        const now = new Date();
        const timestamp = now.getFullYear().toString() +
            (now.getMonth() + 1).toString().padStart(2, '0') +
            now.getDate().toString().padStart(2, '0') +
            now.getHours().toString().padStart(2, '0') +
            now.getMinutes().toString().padStart(2, '0') +
            now.getSeconds().toString().padStart(2, '0');

        const password = Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');

        // 3. Send STK Push Request
        const stkRes = await axios.post(
            'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
            {
                BusinessShortCode: shortCode,
                Password: password,
                Timestamp: timestamp,
                TransactionType: 'CustomerPayBillOnline',
                Amount: amount,
                PartyA: formattedPhone,
                PartyB: shortCode,
                PhoneNumber: formattedPhone,
                CallBackURL: `${baseUrl}/api/isp/mpesa-callback`,
                AccountReference: `RENEW-${ispId.toString().slice(0, 6)}`,
                TransactionDesc: "Platform Subscription Renewal"
            },
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        if (stkRes.data && stkRes.data.ResponseCode === '0') {
            const checkoutId = stkRes.data.CheckoutRequestID;
            
            // Save transaction to Firestore using doc(checkoutId)
            await db.collection('subscription_transactions').doc(checkoutId).set({
                checkoutRequestId: checkoutId,
                ispId: ispId,
                status: 'PENDING',
                amount: amount,
                phone: formattedPhone,
                createdAt: new Date()
            });

            return res.json({
                success: true,
                checkoutRequestId: checkoutId,
                message: "STK push initiated successfully."
            });
        } else {
            return res.status(400).json({ 
                success: false, 
                error: stkRes.data?.CustomerMessage || "Failed to trigger M-Pesa push." 
            });
        }

    } catch (error) {
        // Detailed log for GCP Cloud Run
        const safaricomError = error?.response?.data;
        console.error("STK Push Execution Error:", safaricomError || error.message);

        const clientMessage = safaricomError?.errorMessage 
            || safaricomError?.CustomerMessage 
            || error.message 
            || "Internal payment gateway failure.";

        return res.status(500).json({ 
            success: false, 
            error: clientMessage 
        });
    }
});

// 2. M-Pesa Callback Endpoint (Firestore Native)
app.post('/api/isp/mpesa-callback', async (req, res) => {
    try {
        const db = req.db;
        const callbackData = req.body?.Body?.stkCallback;

        // Safely validate payload before accessing properties
        if (!callbackData) {
            return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
        }

        const checkoutId = callbackData.CheckoutRequestID;
        const resultCode = callbackData.ResultCode;

        // Fetch transaction doc directly using checkoutId document key
        const txnRef = db.collection('subscription_transactions').doc(checkoutId);
        const txnDoc = await txnRef.get();

        if (txnDoc.exists) {
            const txn = txnDoc.data();

            if (resultCode === 0) {
                // Mark transaction as paid in Firestore
                await txnRef.update({
                    status: 'PAID',
                    paidAt: new Date()
                });

                // Fetch current ISP document to preserve existing active time
                const ispRef = db.collection('isps').doc(txn.ispId);
                const ispDoc = await ispRef.get();
                
                let baseDate = Date.now();
                if (ispDoc.exists) {
                    const ispData = ispDoc.data();
                    if (ispData.expiryDate && new Date(ispData.expiryDate.toDate ? ispData.expiryDate.toDate() : ispData.expiryDate) > new Date()) {
                        baseDate = new Date(ispData.expiryDate.toDate ? ispData.expiryDate.toDate() : ispData.expiryDate).getTime();
                    }
                }

                const newExpiryDate = new Date(baseDate + (30 * 24 * 60 * 60 * 1000));

                // Extend subscription expiry date
                await ispRef.set({ expiryDate: newExpiryDate }, { merge: true });
            } else {
                // Mark transaction as failed/cancelled
                await txnRef.update({ status: 'FAILED' });
            }
        }

        return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    } catch (error) {
        console.error("Callback process error:", error);
        return res.json({ ResultCode: 0, ResultDesc: "Accepted with errors" });
    }
});

// 3. Verification Polling Endpoint (Firestore Native)
app.get('/api/isp/verify-subscription/:checkoutId', async (req, res) => {
    try {
        const { checkoutId } = req.params;
        const db = req.db;

        // Fetch transaction by doc ID in Firestore
        const txnDoc = await db.collection('subscription_transactions').doc(checkoutId).get();

        if (!txnDoc.exists) {
            return res.status(404).json({ success: false, status: 'NOT_FOUND' });
        }

        const txn = txnDoc.data();

        return res.json({
            success: true,
            status: txn.status
        });
    } catch (error) {
        console.error("Verification endpoint error:", error);
        return res.status(500).json({ success: false, error: "Failed to verify transaction" });
    }
});

// ====================================================================
// 1. REQUEST PASSWORD RESET
// ====================================================================
app.post('/api/auth/request-password-reset', async (req, res) => {
    try {
        const { email } = req.body || {};
        const db = req.db;

        const cleanEmail = safeStr(email).toLowerCase();
        if (!cleanEmail) {
            return res.status(400).json({ success: false, error: "Email address is required." });
        }

        // 1. Query user by email
        let ispQuery = await db.collection('isp_users')
            .where('email', '==', cleanEmail)
            .limit(1)
            .get();

        let ispRef;
        if (ispQuery.empty) {
            const ispId = cleanEmail.replace(/[^a-zA-Z0-9]/g, "_");
            const docRef = db.collection('isp_users').doc(ispId);
            const docSnap = await docRef.get();
            if (docSnap.exists) ispRef = docRef;
        } else {
            ispRef = ispQuery.docs[0].ref;
        }

        if (!ispRef) {
            console.warn(`[RESET ATTENTION] User email not registered: ${cleanEmail}`);
            return res.status(200).json({ 
                success: true, 
                message: "If that email is registered, a password reset code has been sent." 
            });
        }

        // 2. Generate code and save to Firestore
        const resetCode = crypto.randomInt(100000, 999999).toString();
        const expiresAt = Date.now() + (15 * 60 * 1000); // 15-minute expiry

        await ispRef.update({
            resetCode: resetCode,
            resetCodeExpiresAt: expiresAt
        });

        console.log(`[PASSWORD RESET CODE GENERATED FOR ${cleanEmail}]: ${resetCode}`);

        // 3. Dispatch Email with isolated error handling
        try {
            await sendEmail({
                to: cleanEmail,
                subject: 'Password Reset Code - AudioSpot ISP Portal',
                text: `Your password reset code is: ${resetCode}`,
                html: `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="utf-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <title>Password Reset Code</title>
                    </head>
                    <body style="margin: 0; padding: 0; background-color: #f4f6f9; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
                        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f4f6f9; padding: 40px 0;">
                            <tr>
                                <td align="center">
                                    
                                    <!-- Main Container Card -->
                                    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 560px; background-color: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.03); overflow: hidden;">
                                        
                                        <!-- Header Banner -->
                                        <tr>
                                            <td style="background-color: #4f46e5; padding: 32px 40px; text-align: center;">
                                                <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">AudioSpot</h1>
                                                <p style="color: #e0e7ff; margin: 6px 0 0 0; font-size: 14px; font-weight: 400;">ISP Control Portal</p>
                                            </td>
                                        </tr>

                                        <!-- Body Content -->
                                        <tr>
                                            <td style="padding: 40px 40px 32px 40px;">
                                                <h2 style="color: #0f172a; font-size: 18px; font-weight: 600; margin: 0 0 12px 0;">Password Reset Request</h2>
                                                <p style="color: #475569; font-size: 15px; line-height: 1.6; margin: 0 0 24px 0;">
                                                    Hello, <br><br>
                                                    We received a request to reset your password for your AudioSpot account. Use the verification code below to proceed with resetting your password:
                                                </p>

                                                <!-- Verification Code Block -->
                                                <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin: 28px 0;">
                                                    <tr>
                                                        <td align="center" style="background-color: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 8px; padding: 20px;">
                                                            <span style="font-family: 'Courier New', Courier, monospace; font-size: 36px; font-weight: 800; letter-spacing: 10px; color: #4f46e5; display: inline-block; padding-left: 10px;">
                                                                ${resetCode}
                                                            </span>
                                                        </td>
                                                    </tr>
                                                </table>

                                                <!-- Expiry Notice -->
                                                <p style="color: #e11d48; font-size: 13px; text-align: center; font-weight: 500; margin: 0 0 24px 0;">
                                                    ⏰ This code will expire in <strong>15 minutes</strong>.
                                                </p>

                                                <hr style="border: none; border-top: 1px solid #f1f5f9; margin: 28px 0 20px 0;">

                                                <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin: 0;">
                                                    If you did not request a password reset, you can safely ignore this email. Your account password will remain unchanged.
                                                </p>
                                            </td>
                                        </tr>

                                        <!-- Footer Section -->
                                        <tr>
                                            <td style="background-color: #f8fafc; border-top: 1px solid #f1f5f9; padding: 28px 40px; text-align: center;">
                                                
                                                <!-- Social Media Links / Icons -->
                                                <table role="presentation" border="0" cellspacing="0" cellpadding="0" align="center" style="margin-bottom: 16px;">
                                                    <tr>
                                                        <td style="padding: 0 8px;">
                                                            <a href="https://twitter.com" target="_blank" style="text-decoration: none;">
                                                                <img src="https://cdn-icons-png.flaticon.com/512/733/733579.png" width="20" height="20" alt="Twitter" style="display: block; opacity: 0.7;">
                                                            </a>
                                                        </td>
                                                        <td style="padding: 0 8px;">
                                                            <a href="https://facebook.com" target="_blank" style="text-decoration: none;">
                                                                <img src="https://cdn-icons-png.flaticon.com/512/733/733547.png" width="20" height="20" alt="Facebook" style="display: block; opacity: 0.7;">
                                                            </a>
                                                        </td>
                                                        <td style="padding: 0 8px;">
                                                            <a href="https://instagram.com" target="_blank" style="text-decoration: none;">
                                                                <img src="https://cdn-icons-png.flaticon.com/512/2111/2111463.png" width="20" height="20" alt="Instagram" style="display: block; opacity: 0.7;">
                                                            </a>
                                                        </td>
                                                        <td style="padding: 0 8px;">
                                                            <a href="https://github.com" target="_blank" style="text-decoration: none;">
                                                                <img src="https://cdn-icons-png.flaticon.com/512/733/733553.png" width="20" height="20" alt="GitHub" style="display: block; opacity: 0.7;">
                                                            </a>
                                                        </td>
                                                    </tr>
                                                </table>

                                                <!-- Footer Text -->
                                                <p style="color: #94a3b8; font-size: 12px; margin: 0 0 6px 0;">
                                                    &copy; ${new Date().getFullYear()} AudioSpot ISP Portal. All rights reserved.
                                                </p>
                                                <p style="color: #94a3b8; font-size: 12px; margin: 0;">
                                                    <a href="https://audiory.site" style="color: #6366f1; text-decoration: none;">Visit Website</a> &bull; 
                                                    <a href="https://audiory.site/support" style="color: #6366f1; text-decoration: none;">Help & Support</a>
                                                </p>
                                            </td>
                                        </tr>

                                    </table>
                                    <!-- End Container -->

                                </td>
                            </tr>
                        </table>
                    </body>
                    </html>
                `
            });

            console.log(`[RESEND SUCCESS] Email sent successfully to ${cleanEmail}`);

        } catch (emailErr) {
            console.error(`[RESEND FAILED FOR ${cleanEmail}]:`, emailErr?.message || emailErr);
            return res.status(500).json({ 
                success: false, 
                error: `Failed to deliver email: ${emailErr?.message || "Email service error"}` 
            });
        }

        return res.status(200).json({
            success: true,
            message: "Reset code sent to your email."
        });

    } catch (error) {
        console.error("Password reset error:", error?.message || error);
        return res.status(500).json({ 
            success: false, 
            error: error?.message || "Failed to process reset request." 
        });
    }
});

// ====================================================================
// 2. RESET PASSWORD (Verifies Code & Updates Password)
// ====================================================================
app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const { email, resetCode, newPassword } = req.body;
        const db = req.db;

        if (!email || !resetCode || !newPassword) {
            return res.status(400).json({ success: false, error: "Email, reset code, and new password are required." });
        }

        const ispId = email.replace(/[^a-zA-Z0-9]/g, "_");
        const ispRef = db.collection('isp_users').doc(ispId);
        const ispDoc = await ispRef.get();

        if (!ispDoc.exists) {
            return res.status(404).json({ success: false, error: "Account not found." });
        }

        const ispData = ispDoc.data();

        // 1. Verify code matches
        if (!ispData.resetCode || ispData.resetCode !== resetCode.trim()) {
            return res.status(400).json({ success: false, error: "Invalid verification code." });
        }

        // 2. Check code expiry
        const now = new Date();
        const codeExpiry = ispData.resetCodeExpiresAt?.toDate 
            ? ispData.resetCodeExpiresAt.toDate() 
            : new Date(ispData.resetCodeExpiresAt);

        if (now > codeExpiry) {
            return res.status(400).json({ success: false, error: "Verification code has expired. Please request a new one." });
        }

        // 3. Update password & clear reset token fields
        await ispRef.update({
            password: newPassword, // Note: Hash with bcrypt if using password hashing in production
            resetCode: null,
            resetCodeExpiresAt: null,
            updatedAt: new Date()
        });

        return res.status(200).json({
            success: true,
            message: "Password updated successfully."
        });

    } catch (error) {
        console.error("Password update error:", error);
        return res.status(500).json({ success: false, error: "Failed to update password." });
    }
});

// ====================================================================
// 1. REQUEST PASSWORD RESET
// ====================================================================
app.post('/api/auth/request-password-reset', async (req, res) => {
    try {
        const { email } = req.body || {};
        const db = req.db;

        const cleanEmail = safeStr(email).toLowerCase();
        if (!cleanEmail) {
            return res.status(400).json({ success: false, error: "Email address is required." });
        }

        // 1. Query user by email
        let ispQuery = await db.collection('isp_users')
            .where('email', '==', cleanEmail)
            .limit(1)
            .get();

        let ispRef;
        if (ispQuery.empty) {
            const ispId = cleanEmail.replace(/[^a-zA-Z0-9]/g, "_");
            const docRef = db.collection('isp_users').doc(ispId);
            const docSnap = await docRef.get();
            if (docSnap.exists) ispRef = docRef;
        } else {
            ispRef = ispQuery.docs[0].ref;
        }

        if (!ispRef) {
            console.warn(`[RESET ATTENTION] User email not registered: ${cleanEmail}`);
            return res.status(200).json({ 
                success: true, 
                message: "If that email is registered, a password reset code has been sent." 
            });
        }

        // 2. Generate code and save to Firestore
        const resetCode = crypto.randomInt(100000, 999999).toString();
        const expiresAt = Date.now() + (15 * 60 * 1000); // 15-minute expiry

        await ispRef.update({
            resetCode: resetCode,
            resetCodeExpiresAt: expiresAt
        });

        console.log(`[PASSWORD RESET CODE FOR ${cleanEmail}]: ${resetCode}`);

        // 3. Dispatch Email using helper function
        await sendEmail({
            to: cleanEmail,
            subject: 'Password Reset Code - AudioSpot ISP Portal',
            text: `Your password reset code is: ${resetCode}`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #090d16; color: #f8fafc; padding: 30px; border-radius: 12px; border: 1px solid #1f293d;">
                    <div style="text-align: center; margin-bottom: 24px;">
                        <h2 style="color: #6366f1; margin: 0;">AudioSpot ISP Portal</h2>
                        <p style="color: #94a3b8; font-size: 14px; margin-top: 4px;">Password Recovery Request</p>
                    </div>
                    <div style="background-color: #111827; padding: 24px; border-radius: 8px; border: 1px solid #1f293d;">
                        <p style="font-size: 15px; color: #e2e8f0; margin-top: 0;">Hello,</p>
                        <p style="font-size: 14px; color: #94a3b8;">You requested a password reset for your ISP control account. Use the verification code below to complete the reset process:</p>
                        
                        <div style="text-align: center; margin: 28px 0;">
                            <span style="font-family: monospace; font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #818cf8; background-color: #131a2c; padding: 12px 24px; border-radius: 8px; border: 1px solid #1f293d; display: inline-block;">
                                ${resetCode}
                            </span>
                        </div>
                        
                        <p style="font-size: 13px; color: #f43f5e; text-align: center; margin-bottom: 0;">
                            ⚠️ This code expires in 15 minutes.
                        </p>
                    </div>
                    <p style="font-size: 12px; color: #64748b; text-align: center; margin-top: 24px;">
                        If you did not request this code, please ignore this email or contact support.
                    </p>
                </div>
            `
        });

        console.log(`[Resend Success] Email sent successfully to ${cleanEmail}`);

        return res.status(200).json({
            success: true,
            message: "Reset code sent to your email."
        });

    } catch (error) {
        console.error("Password reset error:", error?.message || error);
        return res.status(500).json({ 
            success: false, 
            error: error?.message || "Failed to process reset request." 
        });
    }
});

// ====================================================================
// 2. RESET PASSWORD (Verifies Code & Updates Password)
// ====================================================================
app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const { email, resetCode, newPassword } = req.body || {};
        const db = req.db;

        if (!email || !resetCode || !newPassword) {
            return res.status(400).json({ 
                success: false, 
                error: "Email, reset code, and new password are required." 
            });
        }

        const normalizedEmail = String(email).trim().toLowerCase();

        // 1. Query user by email
        let ispQuery = await db.collection('isp_users')
            .where('email', '==', normalizedEmail)
            .limit(1)
            .get();

        let ispRef;
        if (ispQuery.empty) {
            const ispId = normalizedEmail.replace(/[^a-zA-Z0-9]/g, "_");
            const docRef = db.collection('isp_users').doc(ispId);
            const docSnap = await docRef.get();
            if (docSnap.exists) ispRef = docRef;
        } else {
            ispRef = ispQuery.docs[0].ref;
        }

        if (!ispRef) {
            return res.status(404).json({ success: false, error: "Account not found." });
        }

        const ispDoc = await ispRef.get();
        const ispData = ispDoc.data() || {};

        // 2. Verify code matches
        if (!ispData.resetCode || String(ispData.resetCode).trim() !== String(resetCode).trim()) {
            return res.status(400).json({ success: false, error: "Invalid verification code." });
        }

        // 3. Check code expiry reliably (handles Timestamps, Numbers, and Date Objects)
        const rawExpiry = ispData.resetCodeExpiresAt;
        let expiryMs = 0;

        if (rawExpiry?.toMillis) {
            expiryMs = rawExpiry.toMillis();
        } else if (rawExpiry?.toDate) {
            expiryMs = rawExpiry.toDate().getTime();
        } else if (typeof rawExpiry === 'number') {
            expiryMs = rawExpiry;
        } else if (rawExpiry) {
            expiryMs = new Date(rawExpiry).getTime();
        }

        if (!expiryMs || Date.now() > expiryMs) {
            return res.status(400).json({ 
                success: false, 
                error: "Verification code has expired. Please request a new one." 
            });
        }

        // 4. Update password & clear reset fields
        // (Optional: const hashedPassword = await bcrypt.hash(newPassword, 10);)
        await ispRef.update({
            password: newPassword, // or hashedPassword
            resetCode: null,
            resetCodeExpiresAt: null,
            updatedAt: new Date()
        });

        console.log(`[PASSWORD RESET SUCCESS] Password updated for ${normalizedEmail}`);

        return res.status(200).json({
            success: true,
            message: "Password updated successfully."
        });

    } catch (error) {
        console.error("Password update error:", error?.message || error);
        return res.status(500).json({ success: false, error: "Failed to update password." });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`AudiSpot Engine Active on port: ${PORT}`));
