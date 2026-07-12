require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Firestore } = require('@google-cloud/firestore');

// Defensive wrapper for MikrotikClient to prevent startup crash if dependency acts up in container environment
let MikrotikClient;
try {
    MikrotikClient = require('mikrotik-node');
} catch (e) {
    console.error("Warning: Mikrotik module load issue:", e.message);
}

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

// [FIXED NEW ROUTE] Fetch live real-time inbound logs directly from Firestore
app.get('/api/hotspot/logs', async (req, res) => {
    const ispId = req.query.ispId || 'default_isp';
    try {
        const snapshot = await db.collection('global_transactions')
            .where('routerId', '!=', '') // Allows checking documents dynamically
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
        
        // Sort newest transactions to the top
        logs.sort((a, b) => new Date(b.processedAt) - new Date(a.processedAt));
        return res.status(200).json(logs);
    } catch (error) {
        console.error("Error reading global transactions ledger:", error.message);
        return res.status(500).json({ error: error.message });
    }
});

// [FIXED NEW ROUTE] Fetch complete router hardware fleet mapping arrays
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

// 4. Register Router Endpoint (Aligned with the frontend route structure directly)
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

                // Trigger remote MikroTik router activation sequence dynamically
                if (ispConfig.routerIp && ispConfig.routerUser && ispConfig.routerPassword) {
                    try {
                        const DynamicMikrotik = require('mikrotik-node');
                        const router = new DynamicMikrotik({
                            host: ispConfig.routerIp, port: parseInt(ispConfig.routerPort || '8728'),
                            user: ispConfig.routerUser, password: ispConfig.routerPassword, timeout: 10000 
                        });

                        router.connect().then(() => {
                            let dynamicPlanProfile = amountPaid >= 20 ? (amountPaid >= 50 ? "24_Hour_Plan" : "3_Hour_Plan") : "1_Hour_Plan";
                            return router.write('/ip/hotspot/user/add', [
                                `=name=${payingPhone}`, `=password=${payingPhone}`, `=profile=${dynamicPlanProfile}`, `=comment=AudiSpot_${mpesaReceipt}`
                            ]);
                        }).then(() => router.close()).catch(err => console.error("Router connection failure:", err.message));
                    } catch (modError) {
                        console.error("Mikrotik execution engine skipped: Module compilation mismatch.", modError.message);
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

// 4b. Dynamic Terminal Script Generation Factory Layer
app.post('/api/hotspot/generate-script', async (req, res) => {
    const { routerId, ispId } = req.body;
    if (!routerId) {
        return res.status(400).json({ success: false, error: "Target router key configuration index is missing." });
    }

    const defaultIspId = ispId || "default_isp";
    
    // Auto-onboard router layout to database structure seamlessly upon code compilation requests
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

        // Generate clean MikroTik terminal configuration code blocks
        const provisioningScript = `/sys identity set name="${routerId}";
/ip hotspot profile add name="AudiSpot_Prof" hotspot-address=10.5.5.1 login-by=http-chap,http-pap;
/ip hotspot profile set "AudiSpot_Prof" html-directory=flash/hotspot;
/ip hotspot walled-garden add dst-host="*.safaricom.co.ke" action=allow;
/ip hotspot walled-garden add dst-host="*.audiory.site" action=allow;
/ip hotspot walled-garden add dst-host="audispot-749056206562.europe-west1.run.app" action=allow;
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

// A. Fetch all active billing packages for a specific ISP tenant
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

// B. Save a new custom access package into Firestore
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

// C. Shred and remove an access product layer entirely
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`AudiSpot Engine Active on port: ${PORT}`));
