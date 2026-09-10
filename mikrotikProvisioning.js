'use strict';

const { RouterOSClient } = require('routeros-client');
const crypto = require('crypto');

/**
 * AudiSpot MikroTik provisioning engine.
 *
 * Design goals:
 * - one RouterOS connection per operation
 * - idempotent create/update operations
 * - no duplicate hotspot users/profiles/bindings
 * - canonical package -> hotspot user provisioning
 * - explicit network/bootstrap helpers
 * - bounded connection timeout and guaranteed close
 * - safe input normalization before values are sent to RouterOS
 */
class MikroTikProvisioningError extends Error {
    constructor(message, code = 'MIKROTIK_ERROR', cause = null) {
        super(message);
        this.name = 'MikroTikProvisioningError';
        this.code = code;
        this.cause = cause;
    }
}

const DEFAULTS = Object.freeze({
    port: 8728,
    timeout: 10000,
    hotspotInterface: 'ether5',
    hotspotAddress: '10.5.50.1/24',
    hotspotGateway: '10.5.50.1',
    hotspotPool: 'audispot-pool',
    hotspotProfile: 'AudiSpot_Prof',
    hotspotUserProfile: 'AudiSpot_UserProf',
    hotspotHtmlDirectory: 'flash/connect',
    hotspotLoginBy: 'http-chap,http-pap',
    hotspotDnsName: 'audiory.net'
});

function cleanString(value, fallback = '') {
    return String(value ?? fallback).trim();
}

function safeName(value, fallback = 'audispot') {
    const s = cleanString(value, fallback).replace(/[^A-Za-z0-9_.:-]/g, '_');
    return s.slice(0, 60) || fallback;
}

function safeUser(value) {
    const s = cleanString(value).replace(/[^A-Za-z0-9_.@:+-]/g, '_');
    if (!s || s.length > 64) throw new MikroTikProvisioningError('Invalid hotspot username.', 'INVALID_USERNAME');
    return s;
}

function safeMac(value) {
    const raw = cleanString(value).replace(/[^a-fA-F0-9]/g, '');
    if (raw.length !== 12) throw new MikroTikProvisioningError('Invalid MAC address.', 'INVALID_MAC');
    return raw.match(/.{2}/g).join(':').toUpperCase();
}

function safePassword(value) {
    const s = cleanString(value);
    if (!s || s.length > 128) throw new MikroTikProvisioningError('Invalid hotspot password.', 'INVALID_PASSWORD');
    return s;
}

function safeComment(value) {
    return cleanString(value).replace(/[\r\n]/g, ' ').slice(0, 180);
}

function escapeRouterValue(value) {
    // routeros-client accepts a string after the key. Quote only when needed.
    const s = String(value ?? '');
    if (/^[A-Za-z0-9_.:@+\-/]+$/.test(s)) return s;
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function durationToSeconds(durationHours) {
    const hours = Number(durationHours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 8760) {
        throw new MikroTikProvisioningError('Package duration must be between 0 and 8760 hours.', 'INVALID_DURATION');
    }
    return Math.max(60, Math.round(hours * 3600));
}

function routerConfig(routerData = {}) {
    const host = cleanString(routerData.routerIp);
    if (!host || ['0.0.0.0', '127.0.0.1'].includes(host)) {
        throw new MikroTikProvisioningError('Router is not configured with a reachable IP address.', 'ROUTER_NOT_CONFIGURED');
    }
    if (!cleanString(routerData.routerUser)) {
        throw new MikroTikProvisioningError('Router API username is missing.', 'ROUTER_USER_MISSING');
    }
    if (routerData.routerPassword === undefined || routerData.routerPassword === null) {
        throw new MikroTikProvisioningError('Router API password is missing.', 'ROUTER_PASSWORD_MISSING');
    }

    return {
        host,
        user: cleanString(routerData.routerUser),
        password: String(routerData.routerPassword),
        port: Number(routerData.routerPort || DEFAULTS.port),
        timeout: Number(routerData.routerTimeout || DEFAULTS.timeout),
        hotspotInterface: safeName(routerData.hotspotInterface || DEFAULTS.hotspotInterface),
        hotspotAddress: cleanString(routerData.hotspotAddress || DEFAULTS.hotspotAddress),
        hotspotGateway: cleanString(routerData.hotspotGateway || DEFAULTS.hotspotGateway),
        hotspotPool: safeName(routerData.hotspotPool || DEFAULTS.hotspotPool),
        hotspotProfile: safeName(routerData.hotspotProfile || DEFAULTS.hotspotProfile),
        hotspotUserProfile: safeName(routerData.hotspotUserProfile || DEFAULTS.hotspotUserProfile),
        hotspotHtmlDirectory: cleanString(routerData.hotspotHtmlDirectory || DEFAULTS.hotspotHtmlDirectory),
        hotspotLoginBy: cleanString(routerData.hotspotLoginBy || DEFAULTS.hotspotLoginBy),
        hotspotDnsName: cleanString(routerData.hotspotDnsName || DEFAULTS.hotspotDnsName)
    };
}

function makeClient(routerData) {
    const cfg = routerConfig(routerData);
    return new RouterOSClient({
        host: cfg.host,
        user: cfg.user,
        password: cfg.password,
        port: cfg.port,
        timeout: cfg.timeout
    });
}

async function withRouter(routerData, fn) {
    const client = makeClient(routerData);
    let api = null;
    try {
        api = await client.connect();
        return await fn(api, routerConfig(routerData));
    } catch (error) {
        if (error instanceof MikroTikProvisioningError) throw error;
        throw new MikroTikProvisioningError(error?.message || 'MikroTik operation failed.', 'ROUTER_API_ERROR', error);
    } finally {
        if (api && typeof api.close === 'function') {
            try { await api.close(); } catch (_) {}
        }
    }
}

async function findOne(api, path, field, value) {
    const results = await api.write(`${path}/print`, [`?${field}=${escapeRouterValue(value)}`]);
    return Array.isArray(results) && results.length ? results[0] : null;
}

async function findMany(api, path, field, value) {
    const results = await api.write(`${path}/print`, [`?${field}=${escapeRouterValue(value)}`]);
    return Array.isArray(results) ? results : [];
}

function routerIdForKey(prefix, value) {
    return `${prefix}-${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 20)}`;
}

async function ensureHotspotProfile(api, profileName, options = {}) {
    const name = safeName(profileName, DEFAULTS.hotspotProfile);
    const existing = await findOne(api, '/ip/hotspot/user/profile', 'name', name);
    const params = [
        `=name=${escapeRouterValue(name)}`
    ];

    if (options.rateLimit) params.push(`=rate-limit=${escapeRouterValue(options.rateLimit)}`);
    if (options.sharedUsers) params.push(`=shared-users=${Number(options.sharedUsers) || 1}`);

    if (!existing) {
        if (options.createIfMissing === false) {
            throw new MikroTikProvisioningError(`Hotspot user profile '${name}' does not exist on the router.`, 'PROFILE_NOT_FOUND');
        }
        await api.write('/ip/hotspot/user/profile/add', params);
        return { created: true, id: null, name };
    }

    const setParams = [`=.id=${existing['.id']}`];
    if (options.rateLimit) setParams.push(`=rate-limit=${escapeRouterValue(options.rateLimit)}`);
    if (options.sharedUsers) setParams.push(`=shared-users=${Number(options.sharedUsers) || 1}`);
    if (setParams.length > 1) await api.write('/ip/hotspot/user/profile/set', setParams);
    return { created: false, id: existing['.id'], name };
}

async function ensureHotspotServer(api, cfg) {
    const addressPrefix = cfg.hotspotAddress.includes('/') ? cfg.hotspotAddress : `${cfg.hotspotAddress}/24`;
    const existingAddress = await findOne(api, '/ip/address', 'address', addressPrefix);
    if (!existingAddress) {
        try {
            await api.write('/ip/address/add', [
                `=address=${escapeRouterValue(addressPrefix)}`,
                `=interface=${escapeRouterValue(cfg.hotspotInterface)}`,
                '=comment="AudiSpot Hotspot Gateway"'
            ]);
        } catch (e) {
            const verify = await findOne(api, '/ip/address', 'address', addressPrefix);
            if (!verify) throw e;
        }
    }

    const pool = await findOne(api, '/ip/pool', 'name', cfg.hotspotPool);
    if (!pool) {
        await api.write('/ip/pool/add', [
            `=name=${escapeRouterValue(cfg.hotspotPool)}`,
            `=ranges=${escapeRouterValue(`${cfg.hotspotGateway.replace(/\.1$/, '.2')} - ${cfg.hotspotGateway.replace(/\.1$/, '.254')}`)}`
        ]);
    }

    await ensureHotspotProfile(api, cfg.hotspotUserProfile, { createIfMissing: true, sharedUsers: 1 });

    const serverProfile = await findOne(api, '/ip/hotspot/profile', 'name', cfg.hotspotProfile);
    if (!serverProfile) {
        await api.write('/ip/hotspot/profile/add', [
            `=name=${escapeRouterValue(cfg.hotspotProfile)}`,
            `=hotspot-address=${escapeRouterValue(cfg.hotspotGateway)}`,
            `=login-by=${escapeRouterValue(cfg.hotspotLoginBy)}`,
            `=html-directory=${escapeRouterValue(cfg.hotspotHtmlDirectory)}`
        ]);
    } else {
        await api.write('/ip/hotspot/profile/set', [
            `=.id=${serverProfile['.id']}`,
            `=hotspot-address=${escapeRouterValue(cfg.hotspotGateway)}`,
            `=login-by=${escapeRouterValue(cfg.hotspotLoginBy)}`,
            `=html-directory=${escapeRouterValue(cfg.hotspotHtmlDirectory)}`
        ]);
    }

    const hotspotServers = await api.write('/ip/hotspot/print');
    const server = Array.isArray(hotspotServers)
        ? hotspotServers.find(s => s.interface === cfg.hotspotInterface)
        : null;

    if (!server) {
        await api.write('/ip/hotspot/add', [
            `=name=${escapeRouterValue(safeName(`audispot-${cfg.hotspotInterface}`))}`,
            `=interface=${escapeRouterValue(cfg.hotspotInterface)}`,
            `=address-pool=${escapeRouterValue(cfg.hotspotPool)}`,
            `=profile=${escapeRouterValue(cfg.hotspotProfile)}`,
            '=disabled=no'
        ]);
    } else {
        const setParams = [`=.id=${server['.id']}`];
        if (server['address-pool'] !== cfg.hotspotPool) setParams.push(`=address-pool=${escapeRouterValue(cfg.hotspotPool)}`);
        if (server.profile !== cfg.hotspotProfile) setParams.push(`=profile=${escapeRouterValue(cfg.hotspotProfile)}`);
        if (setParams.length > 1) await api.write('/ip/hotspot/set', setParams);
    }

    return { interface: cfg.hotspotInterface, address: addressPrefix, pool: cfg.hotspotPool, profile: cfg.hotspotProfile };
}

async function provisionHotspotUser(routerData, options = {}) {
    const username = safeUser(options.username);
    const password = safePassword(options.password || username);
    const profile = safeName(options.profile || DEFAULTS.hotspotUserProfile);
    const comment = safeComment(options.comment || `AudiSpot_${username}`);
    const durationSeconds = options.limitUptimeSeconds ? Math.max(60, Math.round(Number(options.limitUptimeSeconds))) : (options.durationHours ? durationToSeconds(options.durationHours) : null);
    const resetUsage = options.resetUsage !== false;

    return withRouter(routerData, async (api) => {
        await ensureHotspotProfile(api, profile, {
            rateLimit: options.rateLimit,
            sharedUsers: options.sharedUsers || 1,
            createIfMissing: options.createProfileIfMissing === true
        });

        const existingUsers = await findMany(api, '/ip/hotspot/user', 'name', username);
        let user = existingUsers[0] || null;
        const params = [
            `=name=${escapeRouterValue(username)}`,
            `=password=${escapeRouterValue(password)}`,
            `=profile=${escapeRouterValue(profile)}`,
            `=comment=${escapeRouterValue(comment)}`,
            '=disabled=no'
        ];
        if (durationSeconds && resetUsage) params.push(`=limit-uptime=${durationSeconds}s`);

        if (!user) {
            await api.write('/ip/hotspot/user/add', params);
            user = await findOne(api, '/ip/hotspot/user', 'name', username);
            return { created: true, updated: false, user: user || { name: username }, durationSeconds };
        }

        const setParams = [`=.id=${user['.id']}`];
        if (user.password !== password) setParams.push(`=password=${escapeRouterValue(password)}`);
        if (user.profile !== profile) setParams.push(`=profile=${escapeRouterValue(profile)}`);
        if (user.comment !== comment) setParams.push(`=comment=${escapeRouterValue(comment)}`);
        if (user.disabled === 'true' || user.disabled === true) setParams.push('=disabled=no');
        if (durationSeconds && resetUsage) setParams.push(`=limit-uptime=${durationSeconds}s`);
        if (setParams.length > 1) await api.write('/ip/hotspot/user/set', setParams);

        return { created: false, updated: setParams.length > 1, user: { ...user, name: username }, durationSeconds };
    });
}

async function disableHotspotUser(routerData, username, reason = 'AudiSpot expired') {
    const safe = safeUser(username);
    return withRouter(routerData, async (api) => {
        const users = await findMany(api, '/ip/hotspot/user', 'name', safe);
        if (!users.length) return { found: false, disabled: false };
        await api.write('/ip/hotspot/user/set', [
            `=.id=${users[0]['.id']}`,
            '=disabled=yes',
            `=comment=${escapeRouterValue(safeComment(reason))}`
        ]);
        return { found: true, disabled: true };
    });
}

async function disconnectHotspotUser(routerData, username) {
    const safe = safeUser(username);
    return withRouter(routerData, async (api) => {
        const sessions = await findMany(api, '/ip/hotspot/active', 'user', safe);
        for (const session of sessions) {
            await api.write('/ip/hotspot/active/remove', [`=.id=${session['.id']}`]);
        }
        return { disconnected: sessions.length, username: safe };
    });
}

async function listActiveSessions(routerData) {
    return withRouter(routerData, async (api) => {
        const sessions = await api.write('/ip/hotspot/active/print');
        return (Array.isArray(sessions) ? sessions : []).map(s => ({
            id: s['.id'],
            user: s.user || 'Unknown',
            address: s.address || '0.0.0.0',
            macAddress: s['mac-address'] || '00:00:00:00:00:00',
            uptime: s.uptime || '00:00:00',
            bytesIn: Number(s['bytes-in'] || 0),
            bytesOut: Number(s['bytes-out'] || 0)
        }));
    });
}

async function bypassMac(routerData, macAddress, comment = 'AudiSpot device bypass') {
    const mac = safeMac(macAddress);
    return withRouter(routerData, async (api) => {
        const bindings = await findMany(api, '/ip/hotspot/ip-binding', 'mac-address', mac);
        const params = [
            `=mac-address=${escapeRouterValue(mac)}`,
            '=type=bypassed',
            `=comment=${escapeRouterValue(safeComment(comment))}`
        ];
        if (!bindings.length) {
            await api.write('/ip/hotspot/ip-binding/add', params);
            return { created: true, updated: false, mac };
        }
        await api.write('/ip/hotspot/ip-binding/set', [
            `=.id=${bindings[0]['.id']}`,
            '=type=bypassed',
            `=comment=${escapeRouterValue(safeComment(comment))}`
        ]);
        return { created: false, updated: true, mac };
    });
}

async function ensureDhcp(routerData, options = {}) {
    const cfg = routerConfig(routerData);
    const subnet = cleanString(options.subnet || '10.5.50.0/24');
    const gateway = cleanString(options.gateway || cfg.hotspotGateway);
    const iface = safeName(options.interface || cfg.hotspotInterface);
    const poolName = safeName(options.poolName || cfg.hotspotPool);
    const dhcpName = safeName(options.dhcpName || `audispot-dhcp-${iface}`);

    return withRouter(routerData, async (api) => {
        const address = `${gateway}/${subnet.split('/')[1] || '24'}`;
        const addressExists = await findOne(api, '/ip/address', 'address', address);
        if (!addressExists) await api.write('/ip/address/add', [`=address=${escapeRouterValue(address)}`, `=interface=${escapeRouterValue(iface)}`, '=comment="AudiSpot DHCP Gateway"']);

        const pool = await findOne(api, '/ip/pool', 'name', poolName);
        if (!pool) {
            const prefix = subnet.replace(/\.0\/\d+$/, '');
            await api.write('/ip/pool/add', [`=name=${escapeRouterValue(poolName)}`, `=ranges=${escapeRouterValue(`${prefix}.2-${prefix}.254`)}`]);
        }

        const networks = await findMany(api, '/ip/dhcp-server/network', 'address', subnet);
        if (!networks.length) {
            await api.write('/ip/dhcp-server/network/add', [
                `=address=${escapeRouterValue(subnet)}`,
                `=gateway=${escapeRouterValue(gateway)}`,
                `=dns-server=${escapeRouterValue(gateway)}`,
                '=comment="AudiSpot DHCP network"'
            ]);
        }

        const servers = await findMany(api, '/ip/dhcp-server', 'name', dhcpName);
        if (!servers.length) {
            await api.write('/ip/dhcp-server/add', [
                `=name=${escapeRouterValue(dhcpName)}`,
                `=interface=${escapeRouterValue(iface)}`,
                `=address-pool=${escapeRouterValue(poolName)}`,
                '=disabled=no',
                '=comment="AudiSpot DHCP"'
            ]);
        } else {
            await api.write('/ip/dhcp-server/set', [
                `=.id=${servers[0]['.id']}`,
                `=interface=${escapeRouterValue(iface)}`,
                `=address-pool=${escapeRouterValue(poolName)}`,
                '=disabled=no'
            ]);
        }
        return { subnet, gateway, interface: iface, pool: poolName, dhcpServer: dhcpName };
    });
}

async function createPppoeSecret(routerData, options = {}) {
    const username = safeUser(options.username);
    const password = safePassword(options.password);
    const profile = options.profile ? safeName(options.profile) : null;

    return withRouter(routerData, async (api) => {
        const existing = await findMany(api, '/ppp/secret', 'name', username);
        const params = [`=name=${escapeRouterValue(username)}`, `=password=${escapeRouterValue(password)}`];
        if (profile) params.push(`=profile=${escapeRouterValue(profile)}`);
        if (!existing.length) {
            await api.write('/ppp/secret/add', params);
            return { created: true, updated: false, username };
        }
        const setParams = [`=.id=${existing[0]['.id']}`, `=password=${escapeRouterValue(password)}`];
        if (profile) setParams.push(`=profile=${escapeRouterValue(profile)}`);
        await api.write('/ppp/secret/set', setParams);
        return { created: false, updated: true, username };
    });
}

function generateBootstrapScript({ routerId, ispId, interfaceName = DEFAULTS.hotspotInterface, agentToken = '', agentBaseUrl = 'https://audispoty-749056206562.europe-west1.run.app' } = {}) {
    const rid = safeName(routerId, 'audispot-router');
    const isp = safeName(ispId, 'default_isp');
    const iface = safeName(interfaceName, DEFAULTS.hotspotInterface);
    const token = cleanString(agentToken);
    const base = cleanString(agentBaseUrl).replace(/\/$/, '');
    if (!token) throw new MikroTikProvisioningError('Agent registration token is required.', 'AGENT_TOKEN_MISSING');

    const heartbeatUrl = `${base}/api/hotspot/agent/heartbeat?routerId=${encodeURIComponent(rid)}&token=${encodeURIComponent(token)}`;
    // RouterOS scheduler stores on-event as a quoted string, so the inner
    // URL quotes must survive generation as literal backslash+quote characters.
    const schedulerHeartbeatCommand = `/tool fetch url=\\"${heartbeatUrl}\\" keep-result=no`;

    return `# AudiSpot MikroTik installer - generated for ${rid}
# WAN: ether1 (DHCP) | Customer LAN/Hotspot: ${iface} | Gateway: 10.5.50.1

# 1) WAN Internet connection
:if ([:len [/ip dhcp-client find where interface=ether1]] = 0) do={ /ip dhcp-client add interface=ether1 disabled=no comment="AudiSpot WAN" } else={ /ip dhcp-client set [find where interface=ether1] disabled=no }

# 2) Customer network
:if ([:len [/ip address find where address=10.5.50.1/24]] = 0) do={ /ip address add address=10.5.50.1/24 interface=${escapeRouterValue(iface)} comment="AudiSpot Hotspot Gateway" }
:if ([:len [/ip pool find where name=audispot-pool]] = 0) do={ /ip pool add name=audispot-pool ranges=10.5.50.2-10.5.50.254 }
:if ([:len [/ip dhcp-server network find where address=10.5.50.0/24]] = 0) do={ /ip dhcp-server network add address=10.5.50.0/24 gateway=10.5.50.1 dns-server=10.5.50.1 comment="AudiSpot DHCP network" }
:if ([:len [/ip dhcp-server find where name=audispot-dhcp]] = 0) do={ /ip dhcp-server add name=audispot-dhcp interface=${escapeRouterValue(iface)} address-pool=audispot-pool disabled=no comment="AudiSpot DHCP" } else={ /ip dhcp-server set [find where name=audispot-dhcp] interface=${escapeRouterValue(iface)} address-pool=audispot-pool disabled=no }

# 3) DNS + NAT
/ip dns set allow-remote-requests=yes servers=1.1.1.1,8.8.8.8
:if ([:len [/ip firewall nat find where comment="AudiSpot Internet NAT"]] = 0) do={ /ip firewall nat add chain=srcnat src-address=10.5.50.0/24 out-interface=ether1 action=masquerade comment="AudiSpot Internet NAT" }

# 4) Basic firewall protection
:if ([:len [/ip firewall filter find where comment="AudiSpot established"]] = 0) do={ /ip firewall filter add chain=input connection-state=established,related action=accept comment="AudiSpot established" }
:if ([:len [/ip firewall filter find where comment="AudiSpot hotspot input"]] = 0) do={ /ip firewall filter add chain=input in-interface=${escapeRouterValue(iface)} action=accept comment="AudiSpot hotspot input" }
:if ([:len [/ip firewall filter find where comment="AudiSpot forward established"]] = 0) do={ /ip firewall filter add chain=forward connection-state=established,related action=accept comment="AudiSpot forward established" }

# 5) Hotspot
:if ([:len [/ip hotspot profile find where name=AudiSpot_Prof]] = 0) do={ /ip hotspot profile add name=AudiSpot_Prof hotspot-address=10.5.50.1 login-by=http-chap,http-pap html-directory=flash/connect } else={ /ip hotspot profile set [find where name=AudiSpot_Prof] hotspot-address=10.5.50.1 login-by=http-chap,http-pap html-directory=flash/connect }
:if ([:len [/ip hotspot user profile find where name=AudiSpot_UserProf]] = 0) do={ /ip hotspot user profile add name=AudiSpot_UserProf shared-users=1 }
:if ([:len [/ip hotspot find where name=audispot-hotspot]] = 0) do={ /ip hotspot add name=audispot-hotspot interface=${escapeRouterValue(iface)} address-pool=audispot-pool profile=AudiSpot_Prof disabled=no } else={ /ip hotspot set [find where name=audispot-hotspot] interface=${escapeRouterValue(iface)} address-pool=audispot-pool profile=AudiSpot_Prof disabled=no }

# 6) Portal + required walled garden
:if ([:len [/ip hotspot walled-garden find where dst-host=audispot.audiory.site]] = 0) do={ /ip hotspot walled-garden add dst-host=audispot.audiory.site action=allow }
:if ([:len [/ip hotspot walled-garden find where dst-host=audiory.site]] = 0) do={ /ip hotspot walled-garden add dst-host=audiory.site action=allow }
:if ([:len [/ip hotspot walled-garden find where dst-host=safaricom.co.ke]] = 0) do={ /ip hotspot walled-garden add dst-host=safaricom.co.ke action=allow }
:if ([:len [/ip hotspot walled-garden find where dst-host=audispoty-749056206562.europe-west1.run.app]] = 0) do={ /ip hotspot walled-garden add dst-host=audispoty-749056206562.europe-west1.run.app action=allow }
/tool fetch url="${heartbeatUrl}" keep-result=no
/tool fetch url="https://audispot.audiory.site/connect/index.html?ispId=${encodeURIComponent(isp)}" dst-path=flash/connect/index.html keep-result=no

# 7) Router identity + heartbeat scheduler
/sys identity set name=${escapeRouterValue(rid)}
:if ([:len [/system scheduler find where name="audispot-heartbeat"]] = 0) do={ /system scheduler add name="audispot-heartbeat" interval=1m on-event="${schedulerHeartbeatCommand}" policy=read,write,test } else={ /system scheduler set [find where name="audispot-heartbeat"] interval=1m on-event="${schedulerHeartbeatCommand}" policy=read,write,test disabled=no }

:log info "AudiSpot installation complete: ${rid}"`; 
}

module.exports = {
    MikroTikProvisioningError,
    DEFAULTS,
    getRouterClient: makeClient,
    withRouter,
    ensureHotspotProfile,
    ensureHotspotServer,
    provisionHotspotUser,
    disableHotspotUser,
    disconnectHotspotUser,
    listActiveSessions,
    bypassMac,
    ensureDhcp,
    createPppoeSecret,
    generateBootstrapScript,
    safeMac,
    safeUser,
    durationToSeconds,
    routerConfig
};
