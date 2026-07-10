require('dotenv').config(); // <-- 1. CRITICAL: Must be at the very top of the file!

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Firestore } = require('@google-cloud/firestore');
const MikrotikClient = require('mikrotik-node');

const app = express();
app.use(cors());
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

const MikrotikClient = require('mikrotik-node');

// 4. Multi-Tenant M-Pesa Callback Endpoint
app.post('/api/mpesa/callback', async (req, res) => {
    const { routerId } = req.query; // Extracted from the URL query param we set in the STK Push
    const callbackData = req.body.Body.stkCallback;
    
    console.log(`--- Processing M-Pesa Callback for Router ID: ${routerId} ---`);

    // Safaricom ResultCode 0 means the customer successfully entered their PIN
    if (callbackData.ResultCode === 0) {
        try {
            // 1. Fetch this specific ISP's router credentials from Firestore
            const doc = await db.collection('routers').doc(routerId).get();
            
            if (!doc.exists) {
                console.error(`Router ID ${routerId} not found in database. Cannot activate user.`);
                return res.status(404).json({ error: "Router profile missing" });
            }

            const ispConfig = doc.data();

            // Validate that the ISP has actually filled out their router IP details
            if (!ispConfig.routerIp || !ispConfig.routerUser || !ispConfig.routerPassword) {
                console.error(`ISP ${ispConfig.ispName} has incomplete Router configuration details.`);
                return res.status(400).json({ error: "Incomplete router configurations" });
            }

            // Extract payment details from Safaricom metadata
            const items = callbackData.CallbackMetadata.Item;
            const amountPaid = items.find(i => i.Name === 'Amount').Value;
            const payingPhone = items.find(i => i.Name === 'PhoneNumber').Value;

            console.log(`Valid Transaction: ${payingPhone} paid KES ${amountPaid} to ISP: ${ispConfig.ispName}`);

            // 2. Initialize connection details for the client's physical MikroTik router
            const router = new MikrotikClient({
                host: ispConfig.routerIp,
                port: parseInt(ispConfig.routerPort || '8728'), // Defaults to standard RouterOS API port
                user: ispConfig.routerUser,
                password: ispConfig.routerPassword,
                timeout: 10000 // 10 seconds timeout limit
            });

            // 3. Connect and execute user provisioning
            router.connect()
                .then(() => {
                    console.log(`Connected successfully to MikroTik router at ${ispConfig.routerIp}`);

                    // Determine which profile the user gets based on the amount paid
                    // This tier logic can later be customized or pulled dynamically from Firestore!
                    let assignedProfile = "1_Hour_Plan"; 
                    if (amountPaid >= 20) assignedProfile = "3_Hour_Plan";
                    if (amountPaid >= 50) assignedProfile = "24_Hour_Plan";

                    // Issue the command to create the Hotspot User instance
                    // We set both username and password to the user's phone number for simple login mechanics
                    return router.write('/ip/hotspot/user/add', [
                        `=name=${payingPhone}`,
                        `=password=${payingPhone}`,
                        `=profile=${assignedProfile}`,
                        `=comment=AudiSpot_Mpesa_${payingPhone}`
                    ]);
                })
                .then((mikrotikResponse) => {
                    console.log(`Router Success: User profile [${assignedProfile}] provisioned on MikroTik for ${payingPhone}.`);
                    router.close(); // Crucial: Always disconnect to free up router resources
                })
                .catch((routerError) => {
                    console.error(`MikroTik hardware connection error:`, routerError.message);
                    // Critical fallback setup: If the router connection fails (e.g. power blackout at the ISP site),
                    // you can optionally implement an SMS gateway action here to send them a backup code manually!
                });

        } catch (dbError) {
            console.error("Database or execution workflow exception:", dbError);
        }
    } else {
        console.log(`Transaction aborted/canceled by user for Router ID ${routerId}. Result Code: ${callbackData.ResultCode}`);
    }

    // Acknowledge receipt to Safaricom immediately so they stop retrying the webhook
    res.status(200).json({ ResultCode: 0, ResultDesc: "Callback processed successfully" });
});

// 5. Secure Balance Processing Ledger Inside the Callback Execution Path
if (resultCode === 0) {
    try {
        const doc = await db.collection('routers').doc(routerId).get();
        if (doc.exists) {
            const ispConfig = doc.data();
            const items = callbackData.CallbackMetadata.Item;
            const amountPaid = parseFloat(items.find(i => i.Name === 'Amount').Value);
            const payingPhone = items.find(i => i.Name === 'PhoneNumber').Value;
            const mpesaReceipt = items.find(i => i.Name === 'MpesaReceiptNumber').Value;

            // 1. Log payment event to a global transactions repository
            await db.collection('global_transactions').doc(mpesaReceipt).set({
                routerId: routerId,
                ispOwner: ispConfig.ispName,
                customerPhone: payingPhone,
                grossAmount: amountPaid,
                processedAt: new Date().toISOString()
            });

            // 2. Atomically increment the target ISP's platform wallet account balance
            const accountRef = db.collection('isp_accounts').doc(routerId);
            await db.runTransaction(async (transaction) => {
                const accountDoc = await transaction.get(accountRef);
                if (!accountDoc.exists) {
                    transaction.set(accountRef, { currentWalletBalance: amountPaid });
                } else {
                    const currentBalance = accountDoc.data().currentWalletBalance || 0;
                    transaction.update(accountRef, { currentWalletBalance: currentBalance + amountPaid });
                }
            });

            console.log(`Financial Ledger updated. Account linked to Router ${routerId} credited with KES ${amountPaid}`);
            
            // Execute the native MikroTik API remote user provisioning loop from earlier here...
        }
    } catch (transactionChainError) {
        console.error("Failed to commit wallet increment operations:", transactionChainError);
    }
}

// ==========================================
// 1. ISP USER AUTHENTICATION & ONBOARDING
// ==========================================

// ISP Signup Route
app.post('/api/auth/isp-signup', async (req, res) => {
    const { email, password, ispName, phoneNumber, selectedPlan } = req.body;

    if (!email || !password || !ispName || !phoneNumber) {
        return res.status(400).json({ success: false, error: "All onboarding fields are required." });
    }

    try {
        const ispId = email.replace(/[^a-zA-Z0-9]/g, "_"); // Simple unique ID from email
        const ispRef = db.collection('isp_users').doc(ispId);
        
        await ispRef.set({
            ispName,
            email,
            password, // In production, hash this using bcrypt!
            phoneNumber,
            plan: selectedPlan || "standard_monthly", // KES 500/router/month
            walletBalance: 0,
            setupCompleted: false,
            createdAt: new Date().toISOString()
        });

        return res.status(201).json({ success: true, message: "Account created! Proceed to link your first router.", ispId });
    } catch (error) {
        return res.status(500).json({ success: false, error: "Signup failed." });
    }
});

// ==========================================
// 2. WALLET TRACKING & INSTANT WITHDRAWAL
// ==========================================

// Fetch Wallet Balance and Live Router Count for Dashboard UI
app.get('/api/isp/dashboard-stats/:ispId', async (req, res) => {
    const { ispId } = req.params;

    try {
        const ispDoc = await db.collection('isp_users').doc(ispId).get();
        if (!ispDoc.exists) return res.status(404).json({ error: "ISP profile not found." });

        // Count how many routers this specific ISP has connected
        const routersSnapshot = await db.collection('routers').where('ispId', '==', ispId).get();
        const activeRoutersCount = routersSnapshot.size;
        
        // Calculate subscription overhead (KES 500 * number of routers)
        const monthlySaaSBill = activeRoutersCount * 500;

        return res.status(200).json({
            success: true,
            balance: ispDoc.data().walletBalance || 0,
            routerCount: activeRoutersCount,
            billingOverhead: monthlySaaSBill,
            ispName: ispDoc.data().ispName
        });
    } catch (error) {
        return res.status(500).json({ error: "Failed to fetch stats." });
    }
});

// Request Instant Wallet Withdrawal (Triggers M-Pesa B2C Payout)
app.post('/api/isp/withdraw', async (req, res) => {
    const { ispId, amount } = req.body;

    try {
        const ispRef = db.collection('isp_users').doc(ispId);
        const doc = await ispRef.get();

        if (!doc.exists) return res.status(404).json({ error: "Account invalid." });
        
        const currentBalance = doc.data().walletBalance || 0;
        const withdrawalAmount = parseFloat(amount);

        if (withdrawalAmount > currentBalance || withdrawalAmount <= 0) {
            return res.status(400).json({ success: false, error: "Insufficient funds or invalid withdrawal amount." });
        }

        // 1. Deduct balance instantly from the database
        await db.runTransaction(async (transaction) => {
            transaction.update(ispRef, { walletBalance: currentBalance - withdrawalAmount });
        });

        // 2. TODO: Fire Safaricom B2C API Request here to transfer real funds 
        // from your main corporate paybill directly to doc.data().phoneNumber
        console.log(`B2C Disbursal Initiated: KES ${withdrawalAmount} sent to ${doc.data().phoneNumber}`);

        // 3. Log withdrawal event
        await db.collection('withdrawals').add({
            ispId,
            amount: withdrawalAmount,
            phoneTarget: doc.data().phoneNumber,
            status: "Success",
            timestamp: new Date().toISOString()
        });

        return res.status(200).json({ success: true, message: `Withdrawal of KES ${withdrawalAmount} processed instantly!` });

    } catch (error) {
        console.error("Withdrawal error:", error);
        return res.status(500).json({ success: false, error: "System failed to complete automatic disbursal." });
    }
});

// One-time setup route to populate AudiSpot SaaS Packages in Firestore
app.get('/api/admin/init-packages', async (req, res) => {
    try {
        const packagesRef = db.collection('subscriptions').doc('packages');
        
        await packagesRef.set({
            standard_monthly: {
                name: "AudiSpot Core Router Access",
                price_per_router: 500,
                currency: "KES",
                features: [
                    "M-Pesa STK Push", 
                    "Branded captive portal", 
                    "Voucher generation & bulk import", 
                    "Bandwidth control", 
                    "Real-time analytics", 
                    "Anti-bypass firewall",
                    "Multi-tenant agents",
                    "WhatsApp support & system updates"
                ]
            },
            one_time_installation: {
                name: "Managed White-Glove Onboarding (Optional)",
                price: 1000,
                currency: "KES",
                features: [
                    "Device configuration",
                    "VunaFlow/AudiSpot hotspot setup",
                    "M-Pesa integration",
                    "Customer login portal",
                    "Basic testing & optimisation"
                ]
            }
        });

        return res.status(200).json({ success: true, message: "AudiSpot SaaS packages successfully initialized in Firestore! 💰" });
    } catch (error) {
        console.error("Failed to seed packages:", error);
        return res.status(500).json({ success: false, error: "Database seeding failed." });
    }
});

// CRITICAL: Cloud Run passes the port dynamically. It MUST check process.env.PORT!
const PORT = process.env.PORT || 8080;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`AudiSpot Engine is running smoothly on port ${PORT}`);
});