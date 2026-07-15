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

// 1. Core Platform Health Route
app.get('/', (req, res) => {
    res.status(200).send(`AudiSpot Multi-Tenant API Gateway is Live 🚀`);
});

// Fetch live real-time inbound logs directly from Firestore
app.get('/api/hotspot/logs', async (req, res) => {
    const ispId = req.query.ispId || 'default_isp';
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
        
        // Sort newest transactions to the top
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

                // Create global transaction log
                await db.collection('global_transactions').doc(mpesaReceipt).set({
                    routerId, 
                    ispOwner: ispConfig.ispName, 
                    customerPhone: payingPhone, 
                    macAddress: cleanMac,
                    grossAmount: amountPaid, 
                    processedAt: new Date().toISOString()
                });

                // Retrieve custom dynamic rules configuration of the active tenant's portal design settings (Synchronized to isp_portals)
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

                // Create/Update Subscriber record mapping Phone <-> MAC and adding Loyalty Points
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

                // Update ISP Wallet Balance
                const ispRef = db.collection('isp_users').doc(ispId);
                await db.runTransaction(async (ts) => {
                    const ispDoc = await ts.get(ispRef);
                    if (ispDoc.exists) {
                        const currentBalance = ispDoc.data().walletBalance || 0;
                        ts.update(ispRef, { walletBalance: currentBalance + amountPaid });
                    }
                });

                // Trigger remote MikroTik router activation sequence dynamically (Standardized on routeros-client)
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

        // Generate clean MikroTik terminal configuration code blocks (Walled gardens synced)
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

// Fetch all active billing packages for a specific ISP tenant
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

// Save a new custom access package into Firestore
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

// Shred and remove an access product layer entirely
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

// Check Loyalty Points Balance
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

// Redeem Loyalty Points for Free Daily Hotspot Session (Synchronized Collections & Client)
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

// Fetch live active hotspot sessions from MikroTik hardware
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

// Force terminate and disconnect an active user session rule entry
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

// Register a new PPPoE subscriber entry inside MikroTik core secrets database
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

// Read active registered broadband users pool array
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

// Append permanent MAC/IP rule mappings bypass layout arrays
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

// Enumerate configured permanent hardware reservations 
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

// Fetch vouchers for a specific ISP tenant via Firestore query strings
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

// Batch Generate Vouchers tied to actual user packages inside Firestore
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
        return res.status(500).json({ success: false, error: error.message });
    }
});

// Bulk Delete Selected Vouchers Array Mapping Subsystems
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

// Pull Active Portal Configuration Profile Maps Matching Tenant Criteria
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

// Save / Overwrite branding configurations inside Firestore database
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

// Fetch all active expenses for a specific ISP tenant
app.get('/api/expenses', async (req, res) => {
    const { ispId } = req.query;
    const targetTenant = ispId || "default_isp";
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

// Save a new custom expense record into Firestore
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

// Delete an expense record
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

// Fetch dynamic real-time performance analytics directly aggregated from live ledgers
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

// Express Route for Payout Processing
app.post('/api/payouts/request', async (req, res) => {
    const { ispId, amount, phoneNumber } = req.body;

    if (!ispId || !amount || !phoneNumber) {
        return res.status(400).json({ success: false, error: "Missing required payout details." });
    }

    try {
        const ispRef = db.collection('isps').doc(ispId);
        
        // Use a Firestore Transaction to safely prevent double-spending
        const result = await db.runTransaction(async (transaction) => {
            const ispDoc = await transaction.get(ispRef);
            if (!ispDoc.exists) {
                throw new Error("ISP account does not exist.");
            }

            const currentBalance = ispDoc.data().walletBalance || 0;
            if (currentBalance < amount) {
                throw new Error("Insufficient wallet balance for withdrawal.");
            }

            // 1. Deduct from local wallet
            const newBalance = currentBalance - amount;
            transaction.update(ispRef, { walletBalance: newBalance });

            // 2. Queue payout request log
            const payoutRef = db.collection('payouts').doc();
            transaction.set(payoutRef, {
                ispId,
                amount,
                phoneNumber,
                status: 'processing',
                createdAt: new Date().toISOString(),
                payoutId: payoutRef.id
            });

            return { newBalance, payoutId: payoutRef.id };
        });

        // 3. Trigger actual Safaricom B2C dispatch
        const b2cResponse = await sendMpesaB2CPayout(phoneNumber, amount, result.payoutId);

        if (b2cResponse.ResponseCode === "0") {
            // Update request status to 'submitted'
            await db.collection('payouts').doc(result.payoutId).update({
                status: 'submitted',
                conversationId: b2cResponse.ConversationID,
                originatorConversationId: b2cResponse.OriginatorConversationID
            });

            return res.json({ 
                success: true, 
                message: "Payout request submitted to M-Pesa.", 
                payoutId: result.payoutId 
            });
        } else {
            // Roll back wallet deduction if Daraja rejects the execution on the spot
            await ispRef.update({ walletBalance: admin.firestore.FieldValue.increment(amount) });
            await db.collection('payouts').doc(result.payoutId).update({ status: 'failed', error: b2cResponse.ResponseDescription });
            
            return res.status(500).json({ success: false, error: "Daraja registration failed." });
        }

    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`AudiSpot Engine Active on port: ${PORT}`));
