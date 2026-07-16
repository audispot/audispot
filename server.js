require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Firestore } = require('@google-cloud/firestore');
const { RouterOSClient } = require('routeros-client');

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
    
    const MPESA_HOST = process.env.MPESA_ENV === 'production' 
        ? 'https://api.safaricom.co.ke' 
        : 'https://sandbox.safaricom.co.ke';

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
async function getOrCreateSettings(databaseInstance, ispId) {
    const activeDb = databaseInstance || db;
    if (!activeDb) {
        throw new Error("Database reference is undefined. Make sure Firestore is initialized.");
    }
    
    const settingsRef = activeDb.collection('settings').doc(ispId);
    const doc = await settingsRef.get();
    
    if (!doc.exists) {
        const defaultData = {
            ispId: ispId,
            brandName: "AudiSpot Premium Hotspot",
            serverIp: "10.5.5.1",
            supportPhone: "+254700000000",
            redirectUrl: "https://audispot.audiory.site/login",
            defaultPppoePassword: "AudiSpot123",
            tillNumber: "",
            accountName: "Official Bigi",
            accountEmail: "komboismail56@gmail.com",
            accountCompany: "AudiSpot Networks",
            smsActive: false,
            smsCredits: 10
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

// Fetch live real-time inbound logs directly from Firestore
app.get('/api/hotspot/logs', async (req, res) => {
    try {
        const snapshot = await db.collection('global_transactions')
            .where('routerId', '!=', '') 
            .get();
            
        const logs = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            logs.push({
                id: doc.id,
                customerPhone: data.customerPhone || 'Unknown',
                routerId: data.routerId || 'N/A',
                grossAmount: data.grossAmount || 0,
                processedAt: data.processedAt || ''
            });
        });
        
        logs.sort((a, b) => new Date(b.processedAt) - new Date(a.processedAt));
        return res.status(200).json(logs);
    } catch (error) {
        console.error("Error reading global transactions ledger:", error.message);
        return res.status(500).json({ error: error.message });
    }
});

// Fetch complete router hardware fleet mapping arrays
app.get('/api/hotspot/routers', async (req, res) => {
    const ispId = req.query.ispId || 'default_isp';
    try {
        const snapshot = await db.collection('routers').where('ispId', '==', ispId).get();
        const routers = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            routers.push({
                id: doc.id,
                routerIp: data.routerIp || '0.0.0.0',
                routerUser: data.routerUser || 'admin'
            });
        });
        return res.status(200).json(routers);
    } catch (error) {
        console.error("Error pulling router fleet configurations:", error.message);
        return res.status(500).json({ error: error.message });
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
            CallBackURL: `https://audispoty-749056206562.europe-west1.run.app/api/mpesa/callback?routerId=${routerId}`,
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
    const { routerId, macAddress } = req.query; 
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
                const cleanMac = macAddress ? macAddress.toLowerCase().replace(/[^a-f0-9]/g, '') : 'nomac';

                await db.collection('global_transactions').doc(mpesaReceipt).set({
                    routerId, 
                    ispOwner: ispConfig.ispName, 
                    customerPhone: payingPhone, 
                    macAddress: cleanMac,
                    grossAmount: amountPaid, 
                    processedAt: new Date().toISOString()
                });

                const ispId = ispConfig.ispId || "default_isp";
                let earnPointsAmount = 10; 
                try {
                    const designDoc = await db.collection('isp_portals').doc(ispId).get();
                    if (designDoc.exists && designDoc.data().earnPoints) {
                        earnPointsAmount = parseInt(designDoc.data().earnPoints) || 10;
                    }
                } catch (pe) {
                    console.error("Portal config fetch error:", pe.message);
                }

                if (cleanMac !== 'nomac') {
                    const subRef = db.collection('subscribers').doc(cleanMac);
                    await db.runTransaction(async (ts) => {
                        const subDoc = await ts.get(subRef);
                        const currentPoints = subDoc.exists ? (subDoc.data().loyaltyPoints || 0) : 0;
                        ts.set(subRef, {
                            phoneNumber: payingPhone,
                            loyaltyPoints: currentPoints + earnPointsAmount,
                            lastActivePackage: amountPaid,
                            lastActiveTimestamp: new Date().toISOString(),
                            routerId: routerId
                        }, { merge: true });
                    });
                }

                const ispRef = db.collection('isp_users').doc(ispId);
                await db.runTransaction(async (ts) => {
                    const ispDoc = await ts.get(ispRef);
                    if (ispDoc.exists) {
                        const currentBalance = ispDoc.data().walletBalance || 0;
                        ts.update(ispRef, { walletBalance: currentBalance + amountPaid });
                    }
                });

                if (ispConfig.routerIp && ispConfig.routerUser && ispConfig.routerPassword) {
                    try {
                        const client = getRouterClient(ispConfig);
                        const api = await client.connect();
                        
                        let dynamicPlanProfile = amountPaid >= 20 ? (amountPaid >= 50 ? "24_Hour_Plan" : "3_Hour_Plan") : "1_Hour_Plan";
                        await api.write('/ip/hotspot/user/add', [
                            `=name=${payingPhone}`, `=password=${payingPhone}`, `=profile=${dynamicPlanProfile}`, `=comment=AudiSpot_${cleanMac}_${mpesaReceipt}`
                        ]);
                        await api.close();
                    } catch (err) {
                        console.error("Router execution failure:", err.message);
                    }
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
            if (!ispDoc.exists) {
                throw new Error("Account missing.");
            }

            const currentBalance = ispDoc.data().walletBalance || 0;
            const phoneNumber = ispDoc.data().phoneNumber;

            if (wAmount > currentBalance) {
                throw new Error("Insufficient wallet balance.");
            }

            transaction.update(ispRef, { walletBalance: currentBalance - wAmount });

            // FIXED COLLECTION MATCH: Using 'withdrawals' explicitly everywhere
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
            await ispRef.update({ walletBalance: Firestore.FieldValue.increment(wAmount) });
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
        const doc = await routerRef.get();
        
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
        }

        const provisioningScript = `/sys identity set name="${routerId}";
/ip hotspot profile add name="AudiSpot_Prof" hotspot-address=10.5.5.1 login-by=http-chap,http-pap;
/ip hotspot profile set "AudiSpot_Prof" html-directory=flash/hotspot;
/ip hotspot walled-garden add dst-host="*.safaricom.co.ke" action=allow;
/ip hotspot walled-garden add dst-host="*.audiory.site" action=allow;
/ip hotspot walled-garden add dst-host="audispoty-749056206562.europe-west1.run.app" action=allow;
/tool fetch url="https://audispot.audiory.site/portal-files.html" dst-path="flash/hotspot/login.html";
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
    
    const cleanMac = macAddress.toLowerCase().replace(/[^a-f0-9]/g, '');
    try {
        const subDoc = await db.collection('subscribers').doc(cleanMac).get();
        if (!subDoc.exists) {
            return res.status(200).json({ points: 0, phoneNumber: null });
        }
        return res.status(200).json({
            points: subDoc.data().loyaltyPoints || 0,
            phoneNumber: subDoc.data().phoneNumber || null
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

app.post('/api/hotspot/loyalty/redeem', async (req, res) => {
    const { macAddress, routerId } = req.body;
    if (!macAddress || !routerId) {
        return res.status(400).json({ success: false, error: "Missing identity credentials." });
    }

    const cleanMac = macAddress.toLowerCase().replace(/[^a-f0-9]/g, '');

    try {
        const routerDoc = await db.collection('routers').doc(routerId).get();
        if (!routerDoc.exists) return res.status(404).json({ success: false, error: "Router network not found." });
        const routerData = routerDoc.data();

        const ispId = routerData.ispId || "default_isp";
        let pointsRequired = 100; 
        try {
            const designDoc = await db.collection('isp_portals').doc(ispId).get();
            if (designDoc.exists && designDoc.data().redeemPoints) {
                pointsRequired = parseInt(designDoc.data().redeemPoints) || 100;
            }
        } catch (pe) {
            console.error("Design fetch fail during loyalty logic:", pe.message);
        }

        const subRef = db.collection('subscribers').doc(cleanMac);
        const subDoc = await subRef.get();
        if (!subDoc.exists) return res.status(400).json({ success: false, error: "Subscriber profile not found." });

        const currentPoints = subDoc.data().loyaltyPoints || 0;
        if (currentPoints < pointsRequired) {
            return res.status(400).json({ success: false, error: `Insufficient points. You need ${pointsRequired} points.` });
        }

        await db.runTransaction(async (ts) => {
            ts.update(subRef, { 
                loyaltyPoints: currentPoints - pointsRequired,
                lastActiveTimestamp: new Date().toISOString()
            });
        });

        if (routerData.routerIp && routerData.routerUser && routerData.routerPassword) {
            const client = getRouterClient(routerData);
            const phoneUser = subDoc.data().phoneNumber || cleanMac;
            
            const api = await client.connect();
            await api.write('/ip/hotspot/user/add', [
                `=name=${phoneUser}`, `=password=${phoneUser}`, `=profile=24_Hour_Plan`, `=comment=LoyaltyRedeem_${cleanMac}`
            ]);
            await api.close();
        }

        return res.status(200).json({ success: true, message: "Free daily pass activated! Enjoy browsing." });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
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
// SMART TV / GAME CONSOLE BRIDGING ENGINE
// ====================================================================

app.post('/api/hotspot/register-tv', async (req, res) => {
    const { routerId, tvMacAddress, comment } = req.body;
    if (!routerId || !tvMacAddress) {
        return res.status(400).json({ success: false, error: "Missing required setup parameters." });
    }

    const cleanTvMac = tvMacAddress.toUpperCase().replace(/[^A-F0-9]/g, '').replace(/(.{2})(?=.)/g, '$1:');

    try {
        const routerDoc = await db.collection('routers').doc(routerId).get();
        if (!routerDoc.exists) return res.status(404).json({ success: false, error: "Router router node path not found." });
        const routerData = routerDoc.data();

        const client = getRouterClient(routerData);
        const api = await client.connect();
        
        await api.write('/ip/hotspot/ip-binding/add', [
            `=mac-address=${cleanTvMac}`,
            `=type=bypassed`,
            `=comment=${comment || 'SmartTV Setup Bypass'}`
        ]);
        await api.close();

        return res.status(200).json({ success: true, message: `TV Hardware (${cleanTvMac}) bypassed successfully!` });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
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
            uptime: s.uptime || '00:00:00'
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

app.post('/api/pppoe/create-secret', async (req, res) => {
    const { routerId, username, password, profile } = req.body;
    if (!routerId || !username || !password || !profile) {
        return res.status(400).json({ success: false, error: "Missing PPPoE creation attributes." });
    }

    try {
        const routerDoc = await db.collection('routers').doc(routerId).get();
        const routerData = routerDoc.data();

        const client = getRouterClient(routerData);
        const api = await client.connect();
        await api.write('/ppp/secret/add', [
            `=name=${username}`,
            `=password=${password}`,
            `=profile=${profile}`,
            `=service=pppoe`
        ]);
        await api.close();

        return res.status(200).json({ success: true });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/pppoe/secrets', async (req, res) => {
    const { routerId } = req.query;
    try {
        const routerDoc = await db.collection('routers').doc(routerId).get();
        if(!routerDoc.exists) return res.status(200).json([]);
        const routerData = routerDoc.data();

        const client = getRouterClient(routerData);
        const api = await client.connect();
        const secrets = await api.write('/ppp/secret/print');
        await api.close();

        const formattedSecrets = secrets.map(s => ({
            name: s.name,
            profile: s.profile,
            remoteAddress: s['remote-address'] || 'Dynamic Pool'
        }));

        return res.status(200).json(formattedSecrets);
    } catch (error) {
        return res.status(200).json([]);
    }
});

// ====================================================================
// DHCP ENGINE: STATIC LEASE SUBSYSTEM MANAGEMENT
// ====================================================================

app.post('/api/dhcp/create-lease', async (req, res) => {
    const { routerId, macAddress, ipAddress, comment } = req.body;
    if(!routerId || !macAddress || !ipAddress) return res.status(400).json({ success: false });

    try {
        const routerDoc = await db.collection('routers').doc(routerId).get();
        const routerData = routerDoc.data();

        const client = getRouterClient(routerData);
        const api = await client.connect();
        await api.write('/ip/dhcp-server/lease/add', [
            `=mac-address=${macAddress}`,
            `=address=${ipAddress}`,
            `=comment=${comment || 'AudiSpot Static Bind'}`
        ]);
        await api.close();

        return res.status(200).json({ success: true });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/dhcp/leases', async (req, res) => {
    const { routerId } = req.query;
    try {
        const routerDoc = await db.collection('routers').doc(routerId).get();
        if(!routerDoc.exists) return res.status(200).json([]);
        const routerData = routerDoc.data();

        const client = getRouterClient(routerData);
        const api = await client.connect();
        const leases = await api.write('/ip/dhcp-server/lease/print');
        await api.close();

        const staticLeases = leases.filter(l => l.dynamic === 'false').map(l => ({
            macAddress: l['mac-address'],
            address: l.address,
            comment: l.comment || 'Permanent Device'
        }));

        return res.status(200).json(staticLeases);
    } catch(err) {
        return res.status(200).json([]);
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
        const docRef = db.collection('isp_portals').doc(ispId);
        const doc = await docRef.get();
        
        if (!doc.exists) {
            return res.status(200).json({
                brandName: "AudiSpot Wireless",
                welcomeGreeting: "Enter verification parameters to connect.",
                supportContact: "0700000000",
                accentColor: "#4f46e5",
                earnPoints: 10,
                redeemPoints: 100,
                reconnectMsg: "Click button below to search active sessions.",
                tvSetup: "1. Locate MAC address of TV\n2. Submit register address\n3. TV is authorized automatically.",
                successTitle: "Welcome Online!",
                successSub: "Your account connection rules are fully operational.",
                successBtn: "Proceed to Browsing"
            });
        }
        return res.status(200).json(doc.data());
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

app.post('/api/portal/design/save', async (req, res) => {
    const { 
        ispId, brandName, welcomeGreeting, supportContact, accentColor,
        earnPoints, redeemPoints, reconnectMsg, tvSetup,
        successTitle, successSub, successBtn
    } = req.body;

    try {
        const targetTenant = ispId || 'default_isp';
        await db.collection('isp_portals').doc(targetTenant).set({
            brandName,
            welcomeGreeting,
            supportContact,
            accentColor,
            earnPoints: parseInt(earnPoints) || 10,
            redeemPoints: parseInt(redeemPoints) || 100,
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
        const snapshot = await db.collection('isp_expenses')
            .where('ispId', '==', targetTenant)
            .get();
            
        const expenses = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            expenses.push({
                id: doc.id,
                description: data.description || "Uncategorized Expense",
                amount: data.amount || 0,
                category: data.category || "General",
                date: data.date || new Date().toISOString()
            });
        });
        
        expenses.sort((a, b) => new Date(b.date) - new Date(a.date));
        return res.status(200).json(expenses);
    } catch (error) {
        console.error("Failed to fetch custom expenses:", error.message);
        return res.status(500).json({ error: error.message });
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
        const routersSnapshot = await db.collection('routers')
            .where('ispId', '==', targetTenant)
            .get();
            
        const routerIds = [];
        routersSnapshot.forEach(doc => routerIds.push(doc.id));
        
        let totalRevenue = 0;
        let transactionCount = 0;
        const revenueOverTime = {}; 
        
        if (routerIds.length > 0) {
            const chunks = [];
            for (let i = 0; i < routerIds.length; i += 30) {
                chunks.push(routerIds.slice(i, i + 30));
            }
            
            for (const chunk of chunks) {
                const txSnapshot = await db.collection('global_transactions')
                    .where('routerId', 'in', chunk)
                    .get();
                    
                txSnapshot.forEach(doc => {
                    const data = doc.data();
                    const amount = data.grossAmount || 0;
                    totalRevenue += amount;
                    transactionCount++;
                    
                    const rawDate = data.processedAt || new Date().toISOString();
                    const dayString = rawDate.split('T')[0];
                    revenueOverTime[dayString] = (revenueOverTime[dayString] || 0) + amount;
                });
            }
        }
        
        const expensesSnapshot = await db.collection('isp_expenses')
            .where('ispId', '==', targetTenant)
            .get();
            
        let totalExpenses = 0;
        const expensesByCategory = {};
        
        expensesSnapshot.forEach(doc => {
            const data = doc.data();
            const amount = data.amount || 0;
            totalExpenses += amount;
            
            const category = data.category || "General";
            expensesByCategory[category] = (expensesByCategory[category] || 0) + amount;
        });
        
        const subscribersSnapshot = await db.collection('subscribers')
            .where('routerId', 'in', routerIds.length > 0 ? routerIds : ['__non_existent__'])
            .get();
            
        const totalSubscribers = subscribersSnapshot.size;
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
                totalRouters: routerIds.length,
                transactionCount
            },
            expensesByCategory,
            chartTimeline
        });
    } catch (error) {
        console.error("Analytics compile error:", error.message);
        return res.status(500).json({ error: error.message });
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
    try {
        const settings = await getOrCreateSettings(req.db, ispId);
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

app.post('/api/settings/mpesa', async (req, res) => {
    const ispId = req.query.ispId || 'default_isp';
    const { tillNumber } = req.body;
    try {
        await req.db.collection('settings').doc(ispId).set({ tillNumber }, { merge: true });
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
    try {
        await req.db.collection('settings').doc(ispId).set({
            brandName,
            serverIp,
            supportPhone,
            redirectUrl
        }, { merge: true });
        res.sendStatus(200);
    } catch (err) {
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

        // Simple password verification (In production, use bcrypt hashing!)
        if (ispData.password !== password) {
            return res.status(401).json({ success: false, error: "Invalid email or password." });
        }

        // Generate a simple token (or use JWT in production)
        const token = Buffer.from(`${ispId}:${Date.now()}`).toString('base64');

        return res.status(200).json({
            success: true,
            token: token,
            ispId: ispId,
            ispName: ispData.ispName
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`AudiSpot Engine Active on port: ${PORT}`));
