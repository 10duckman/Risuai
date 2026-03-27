const express = require('express');
const app = express();
const path = require('path');
const htmlparser = require('node-html-parser');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const fs = require('fs/promises')
const nodeCrypto = require('crypto')
app.use(express.static(path.join(process.cwd(), 'dist'), {index: false}));
app.use(express.json({ limit: '100mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '100mb' }));
app.use(express.text({ limit: '100mb' }));
const {pipeline} = require('stream/promises')
const https = require('https');
const sslPath = path.join(process.cwd(), 'server/node/ssl/certificate');
const hubURL = 'https://sv.risuai.xyz'; 
const openid = require('openid-client');

let password = ''
let knownPublicKeysHashes = []

const savePath = path.join(process.cwd(), "save")
if(!existsSync(savePath)){
    mkdirSync(savePath)
}

const passwordPath = path.join(process.cwd(), 'save', '__password')
if(existsSync(passwordPath)){
    password = readFileSync(passwordPath, 'utf-8')
}

const authCodePath = path.join(process.cwd(), 'save', '__authcode')
const hexRegex = /^[0-9a-fA-F]+$/;

function isHex(str) {
    return hexRegex.test(str.toUpperCase().trim()) || str === '__password';
}

async function hashJSON(json){
    const hash = nodeCrypto.createHash('sha256');
    hash.update(JSON.stringify(json));
    return hash.digest('hex');
}

app.get('/', async (req, res, next) => {

    const clientIP = req.headers['x-forwarded-for'] || req.ip || req.socket.remoteAddress || 'Unknown IP';
    const timestamp = new Date().toISOString();
    console.log(`[Server] ${timestamp} | Connection from: ${clientIP}`);
    
    try {
        const mainIndex = await fs.readFile(path.join(process.cwd(), 'dist', 'index.html'))
        const root = htmlparser.parse(mainIndex)
        const head = root.querySelector('head')
        head.innerHTML = `<script>globalThis.__NODE__ = true</script>` + head.innerHTML
        
        res.send(root.toString())
    } catch (error) {
        console.log(error)
        next(error)
    }
})

async function checkAuth(req, res, returnOnlyStatus = false){
    try {
        const authHeader = req.headers['risu-auth'];

        if(!authHeader){
            console.log('No auth header')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'No auth header'
            });
            return false
        }


        //jwt token
        const [
            jsonHeaderB64,
            jsonPayloadB64,
            signatureB64,
        ] = authHeader.split('.');

        //alg, typ
        const jsonHeader = JSON.parse(Buffer.from(jsonHeaderB64, 'base64url').toString('utf-8'));

        //iat, exp, pub
        const jsonPayload = JSON.parse(Buffer.from(jsonPayloadB64, 'base64url').toString('utf-8'));

        //signature
        const signature = Buffer.from(signatureB64, 'base64url');

        
        //check expiration
        const now = Math.floor(Date.now() / 1000);
        if(jsonPayload.exp < now){
            console.log('Token expired')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'Token Expired'
            });
            return false
        }

        //check if public key is known
        const pubKeyHash = await hashJSON(jsonPayload.pub)
        if(!knownPublicKeysHashes.includes(pubKeyHash)){
            console.log('Unknown public key')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'Unknown Public Key'
            });
            return false
        }

        //check signature
        if(jsonHeader.alg !== "ES256"){
            //only support ECDSA for now
            console.log('Unsupported algorithm')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'Unsupported Algorithm'
            });
            return false
        }

        const isValid = await crypto.subtle.verify(
            {
                name: 'ECDSA',
                hash: {name: 'SHA-256'},
            },
            await crypto.subtle.importKey(
                'jwk',
                jsonPayload.pub,
                {
                    name: 'ECDSA',
                    namedCurve: 'P-256',
                },
                false,
                ['verify']
            ),
            signature,
            Buffer.from(`${jsonHeaderB64}.${jsonPayloadB64}`)
        );

        if(!isValid){
            console.log('Invalid signature')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'Invalid Signature'
            });
            return false
        }
        
        return true   
    } catch (error) {
        console.log(error)
        if(returnOnlyStatus){
            return false;
        }
        res.status(500).send({
            error:'Internal Server Error'
        });
        return false
    }
}

const reverseProxyFunc = async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    
    const urlParam = req.headers['risu-url'] ? decodeURIComponent(req.headers['risu-url']) : req.query.url;

    if (!urlParam) {
        res.status(400).send({
            error:'URL has no param'
        });
        return;
    }
    const header = req.headers['risu-header'] ? JSON.parse(decodeURIComponent(req.headers['risu-header'])) : req.headers;
    if(!header['x-forwarded-for']){
        header['x-forwarded-for'] = req.ip
    }

    if(req.headers['authorization']?.startsWith('X-SERVER-REGISTER')){
        if(!existsSync(authCodePath)){
            delete header['authorization']
        }
        else{
            const authCode = await fs.readFile(authCodePath, {
                encoding: 'utf-8'
            })
            header['authorization'] = `Bearer ${authCode}`
        }
    }
    let originalResponse;
    try {
        // make request to original server
        originalResponse = await fetch(urlParam, {
            method: req.method,
            headers: header,
            body: JSON.stringify(req.body)
        });
        // get response body as stream
        const originalBody = originalResponse.body;
        // get response headers
        const head = new Headers(originalResponse.headers);
        head.delete('content-security-policy');
        head.delete('content-security-policy-report-only');
        head.delete('clear-site-data');
        head.delete('Cache-Control');
        head.delete('Content-Encoding');
        const headObj = {};
        for (let [k, v] of head) {
            headObj[k] = v;
        }
        // send response headers to client
        res.header(headObj);
        // send response status to client
        res.status(originalResponse.status);
        // send response body to client
        await pipeline(originalResponse.body, res);


    }
    catch (err) {
        next(err);
        return;
    }
}

const reverseProxyFunc_get = async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    
    const urlParam = req.headers['risu-url'] ? decodeURIComponent(req.headers['risu-url']) : req.query.url;

    if (!urlParam) {
        res.status(400).send({
            error:'URL has no param'
        });
        return;
    }
    const header = req.headers['risu-header'] ? JSON.parse(decodeURIComponent(req.headers['risu-header'])) : req.headers;
    if(!header['x-forwarded-for']){
        header['x-forwarded-for'] = req.ip
    }
    let originalResponse;
    try {
        // make request to original server
        originalResponse = await fetch(urlParam, {
            method: 'GET',
            headers: header
        });
        // get response body as stream
        const originalBody = originalResponse.body;
        // get response headers
        const head = new Headers(originalResponse.headers);
        head.delete('content-security-policy');
        head.delete('content-security-policy-report-only');
        head.delete('clear-site-data');
        head.delete('Cache-Control');
        head.delete('Content-Encoding');
        const headObj = {};
        for (let [k, v] of head) {
            headObj[k] = v;
        }
        // send response headers to client
        res.header(headObj);
        // send response status to client
        res.status(originalResponse.status);
        // send response body to client
        await pipeline(originalResponse.body, res);
    }
    catch (err) {
        next(err);
        return;
    }
}

let accessTokenCache = {
    token: null,
    expiry: 0
}
async function getSionywAccessToken() {
    if(accessTokenCache.token && Date.now() < accessTokenCache.expiry){
        return accessTokenCache.token;
    }
    //Schema of the client data file
    // {
    //     refresh_token: string;
    //     client_id: string;
    //     client_secret: string;
    // }
    
    const clientDataPath = path.join(process.cwd(), 'save', '__sionyw_client_data.json');
    let refreshToken = ''
    let clientId = ''
    let clientSecret = ''
    if(!existsSync(clientDataPath)){
        throw new Error('No Sionyw client data found');
    }
    const clientDataRaw = readFileSync(clientDataPath, 'utf-8');
    const clientData = JSON.parse(clientDataRaw);
    refreshToken = clientData.refresh_token;
    clientId = clientData.client_id;
    clientSecret = clientData.client_secret;

    //Oauth Refresh Token Flow
    
    const tokenResponse = await fetch('account.sionyw.com/account/api/oauth/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret
        })
    })

    if(!tokenResponse.ok){
        throw new Error('Failed to refresh Sionyw access token');
    }

    const tokenData = await tokenResponse.json();

    //Update the refresh token in the client data file
    if(tokenData.refresh_token && tokenData.refresh_token !== refreshToken){
        clientData.refresh_token = tokenData.refresh_token;
        writeFileSync(clientDataPath, JSON.stringify(clientData), 'utf-8');
    }

    accessTokenCache.token = tokenData.access_token;
    accessTokenCache.expiry = Date.now() + (tokenData.expires_in * 1000) - (5 * 60 * 1000); //5 minutes early

    return tokenData.access_token;
}


async function hubProxyFunc(req, res) {
    const excludedHeaders = [
        'content-encoding',
        'content-length',
        'transfer-encoding'
    ];

    try {
        let externalURL = '';

        const pathHeader = req.headers['x-risu-node-path'];
        if (pathHeader) {
            const decodedPath = decodeURIComponent(pathHeader);
            externalURL = decodedPath;
        } else {
            const pathAndQuery = req.originalUrl.replace(/^\/hub-proxy/, '');
            externalURL = hubURL + pathAndQuery;
        }
        
        const headersToSend = { ...req.headers };
        delete headersToSend.host;
        delete headersToSend.connection;
        delete headersToSend['content-length'];
        delete headersToSend['x-risu-node-path'];

        const hubOrigin = new URL(hubURL).origin;
        headersToSend.origin = hubOrigin;

        //if Authorization header is "Server-Auth, set the token to be Server-Auth
        if(headersToSend['Authorization'] === 'X-Node-Server-Auth'){
            //this requires password auth
            if(!await checkAuth(req, res)){
                return;
            }

            headersToSend['Authorization'] = "Bearer " + await getSionywAccessToken();
            delete headersToSend['risu-auth'];
        }
        
        
        const response = await fetch(externalURL, {
            method: req.method,
            headers: headersToSend,
            body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
            redirect: 'manual',
            duplex: 'half'
        });
        
        for (const [key, value] of response.headers.entries()) {
            // Skip encoding-related headers to prevent double decoding
            if (excludedHeaders.includes(key.toLowerCase())) {
                continue;
            }
            res.setHeader(key, value);
        }
        res.status(response.status);

        if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
            const redirectUrl = response.headers.get('location');
            const newHeaders = { ...headersToSend };
            const redirectResponse = await fetch(redirectUrl, {
                method: req.method,
                headers: newHeaders,
                body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
                redirect: 'manual',
                duplex: 'half'
            });
            for (const [key, value] of redirectResponse.headers.entries()) {
                if (excludedHeaders.includes(key.toLowerCase())) {
                    continue;
                }
                res.setHeader(key, value);
            }
            res.status(redirectResponse.status);
            if (redirectResponse.body) {
                await pipeline(redirectResponse.body, res);
            } else {
                res.end();
            }
            return;
        }
        
        if (response.body) {
            await pipeline(response.body, res);
        } else {
            res.end();
        }
        
    } catch (error) {
        console.error("[Hub Proxy] Error:", error);
        if (!res.headersSent) {
            res.status(502).send({ error: 'Proxy request failed: ' + error.message });
        } else {
            res.end();
        }
    }
}

app.get('/proxy', reverseProxyFunc_get);
app.get('/proxy2', reverseProxyFunc_get);
app.get('/hub-proxy/*', hubProxyFunc);

app.post('/proxy', reverseProxyFunc);
app.post('/proxy2', reverseProxyFunc);
app.post('/hub-proxy/*', hubProxyFunc);

// Gateway proxy — forwards requests with SSE heartbeat
app.options('/gateway/proxy', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, risu-auth, risu-url, risu-header');
    res.status(204).end();
});
app.post('/gateway/proxy', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!await checkAuth(req, res)) {
        return;
    }

    const urlParam = req.headers['risu-url'] ? decodeURIComponent(req.headers['risu-url']) : null;
    if (!urlParam) {
        res.status(400).json({ error: 'URL has no param' });
        return;
    }

    const header = req.headers['risu-header'] ? JSON.parse(decodeURIComponent(req.headers['risu-header'])) : {};
    if (!header['x-forwarded-for']) {
        header['x-forwarded-for'] = req.ip;
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Heartbeat to prevent iOS WebKit 60s timeout
    const heartbeat = setInterval(() => {
        res.write(':heartbeat\n\n');
    }, 15000);

    req.on('close', () => {
        clearInterval(heartbeat);
    });

    try {
        const originalResponse = await fetch(urlParam, {
            method: req.method,
            headers: header,
            body: JSON.stringify(req.body)
        });

        if (!originalResponse.ok) {
            clearInterval(heartbeat);
            res.write(`data: ${JSON.stringify({ type: 'error', error: { message: `HTTP ${originalResponse.status}` } })}\n\n`);
            res.end();
            return;
        }

        // Pipe LLM response through, heartbeat keeps connection alive
        for await (const chunk of originalResponse.body) {
            res.write(chunk);
        }

        clearInterval(heartbeat);
        res.end();
    } catch (err) {
        console.error('[Gateway] Proxy error:', err.message || err);
        clearInterval(heartbeat);
        if (res.headersSent) {
            res.write(`data: ${JSON.stringify({ type: 'error', error: { message: err.message || 'Gateway proxy error' } })}\n\n`);
            res.end();
        } else {
            res.status(500).json({ error: err.message || 'Gateway proxy error' });
        }
    }
});

// Bedrock ConverseStream gateway
app.options('/gateway/bedrock-stream', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, risu-auth, x-chat-id, x-cache-ttl');
    res.status(204).end();
});
app.post('/gateway/bedrock-stream', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!await checkAuth(req, res)) {
        return;
    }

    try {
        const { modelId, messages, system, inferenceConfig, bearerToken: clientBearerToken, thinking: thinkingConfig, thinkingEffort } = req.body;

        if (!modelId) {
            res.status(400).json({ error: 'modelId is required' });
            return;
        }

        const { BedrockRuntimeClient, ConverseStreamCommand } = require('@aws-sdk/client-bedrock-runtime');

        const apiKey = clientBearerToken || process.env.AWS_BEARER_TOKEN_BEDROCK || '';
        const envRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

        let clientConfig = { region: envRegion };

        // Detect credential format
        if (apiKey.includes(':')) {
            // Format: accessKeyId:secretAccessKey:region
            const parts = apiKey.split(':');
            if (parts.length >= 3) {
                clientConfig.region = parts[2];
                clientConfig.credentials = {
                    accessKeyId: parts[0],
                    secretAccessKey: parts[1],
                };
            }
        } else if (apiKey) {
            // Bearer token format
            clientConfig.token = { token: apiKey };
        }
        // else: fall back to AWS SDK default credential chain (env vars, profile, etc.)

        const client = new BedrockRuntimeClient(clientConfig);

        const chatId = req.headers['x-chat-id'] || '';
        console.log(`[Gateway] Bedrock request: modelId=${modelId}, region=${clientConfig.region}${chatId ? ', chatId=' + chatId : ''}`);

        // Gateway logging (GATEWAY_LOG=true to enable)
        const gatewayLog = process.env.GATEWAY_LOG === 'true';
        let logId = '';
        if (gatewayLog) {
            logId = `${Date.now()}_${modelId.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
            const logDir = path.join(process.cwd(), 'save', 'gateway-logs');
            if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
            const reqLog = { modelId, system: system ? `${system.length} chars` : null, messages: messages?.length + ' messages', inferenceConfig, chatId, timestamp: new Date().toISOString() };
            const fullReqLog = { modelId, system, messages, inferenceConfig, chatId, timestamp: new Date().toISOString() };
            fs.writeFile(path.join(logDir, `${logId}_req.json`), JSON.stringify(fullReqLog, null, 2)).catch(() => {});
            console.log(`[Gateway] Log: ${logId}`, JSON.stringify(reqLog));
        }

        const cacheTtl = req.headers['x-cache-ttl'] || '5m';

        // Trim trailing whitespace from assistant messages (Bedrock rejects it)
        if (messages) {
            for (const m of messages) {
                if (m.role === 'assistant' && Array.isArray(m.content)) {
                    for (const b of m.content) {
                        if (b.text && typeof b.text === 'string') {
                            b.text = b.text.trimEnd();
                        }
                    }
                }
            }
        }

        const commandParams = {
            modelId,
            messages,
            system: system ? [{ text: system }, { cachePoint: { type: "default", ttl: cacheTtl } }] : undefined,
            inferenceConfig,
        };

        if (thinkingConfig?.type === 'enabled' && thinkingConfig?.budget_tokens > 0) {
            commandParams.additionalModelRequestFields = {
                thinking: { type: 'enabled', budget_tokens: thinkingConfig.budget_tokens }
            };
        } else if (thinkingConfig?.type === 'adaptive') {
            commandParams.additionalModelRequestFields = {
                thinking: { type: 'adaptive' }
            };
            if (thinkingEffort) {
                commandParams.additionalModelRequestFields.thinking.effort = thinkingEffort;
            }
        }

        const command = new ConverseStreamCommand(commandParams);

        // SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        // Heartbeat to prevent iOS WebKit 60s timeout
        const heartbeat = setInterval(() => {
            res.write(':heartbeat\n\n');
        }, 15000);

        // Handle client disconnect
        req.on('close', () => {
            clearInterval(heartbeat);
        });

        const response = await client.send(command);

        let thinking = false;
        let responseText = '';
        for await (const event of response.stream) {
            if (event.contentBlockStart) {
                const block = event.contentBlockStart.start;
                if (block?.toolUse) {
                    // tool use block — pass as-is
                    res.write(`data: ${JSON.stringify({
                        type: 'content_block_start',
                        content_block: { type: 'tool_use', id: block.toolUse.toolUseId, name: block.toolUse.name }
                    })}\n\n`);
                }
            } else if (event.contentBlockDelta) {
                const delta = event.contentBlockDelta.delta;
                if (delta?.text) {
                    responseText += delta.text;
                    // Text delta — emit as Anthropic SSE format
                    res.write(`data: ${JSON.stringify({
                        type: 'content_block_delta',
                        delta: { type: 'text_delta', text: delta.text }
                    })}\n\n`);
                } else if (delta?.reasoningContent?.text) {
                    // Thinking delta
                    res.write(`data: ${JSON.stringify({
                        type: 'content_block_delta',
                        delta: { type: 'thinking_delta', thinking: delta.reasoningContent.text }
                    })}\n\n`);
                } else if (delta?.toolUse) {
                    // Tool use delta
                    res.write(`data: ${JSON.stringify({
                        type: 'content_block_delta',
                        delta: { type: 'input_json_delta', partial_json: delta.toolUse.input }
                    })}\n\n`);
                }
            } else if (event.messageStop) {
                res.write(`data: ${JSON.stringify({
                    type: 'message_stop'
                })}\n\n`);
            } else if (event.metadata) {
                // Usage info + cache stats
                const usage = event.metadata.usage;
                console.log(`[Gateway] Usage: input=${usage?.inputTokens} output=${usage?.outputTokens} cacheRead=${usage?.cacheReadInputTokens || 0} cacheWrite=${usage?.cacheWriteInputTokens || 0}`);
                if (gatewayLog && logId) {
                    const logDir = path.join(process.cwd(), 'save', 'gateway-logs');
                    fs.writeFile(path.join(logDir, `${logId}_res.json`), JSON.stringify({ usage, responseText, chatId, timestamp: new Date().toISOString() }, null, 2)).catch(() => {});
                }
                res.write(`data: ${JSON.stringify({
                    type: 'message_delta',
                    usage: usage,
                    responseLength: responseText.length
                })}\n\n`);
            }
        }

        clearInterval(heartbeat);
        res.end();
    } catch (err) {
        console.error(`[Gateway] Bedrock error:`, err.message || err);
        // If headers already sent, send error via SSE
        if (res.headersSent) {
            res.write(`data: ${JSON.stringify({
                type: 'error',
                error: { message: err.message || 'Bedrock ConverseStream error' }
            })}\n\n`);
            res.end();
        } else {
            res.status(500).json({ error: err.message || 'Bedrock ConverseStream error' });
        }
    }
});

// Gateway response recovery endpoint
app.get('/gateway/recover', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!await checkAuth(req, res)) {
        return;
    }
    try {
        const chatId = req.query.chatId;
        const logDir = path.join(process.cwd(), 'save', 'gateway-logs');
        if (!existsSync(logDir)) {
            return res.status(404).json({ error: 'No gateway logs found' });
        }
        const files = (await fs.readdir(logDir))
            .filter(f => f.endsWith('_res.json'))
            .sort()
            .reverse();

        // 1) Match by chatId
        if (chatId) {
            for (const file of files) {
                const data = JSON.parse(await fs.readFile(path.join(logDir, file), 'utf-8'));
                if (data.chatId === chatId) {
                    return res.json({ responseText: data.responseText, chatId: data.chatId, timestamp: data.timestamp });
                }
            }
        }

        // 2) Fallback: match by timestamp (for logs without chatId)
        const msgTime = req.query.time ? parseInt(req.query.time) : 0;
        if (msgTime) {
            let bestMatch = null;
            let bestDiff = Infinity;
            for (const file of files) {
                // Extract timestamp from filename: {timestamp}_{modelId}_res.json
                const fileTs = parseInt(file.split('_')[0]);
                if (isNaN(fileTs)) continue;
                const diff = Math.abs(fileTs - msgTime);
                // Within 5 minutes window
                if (diff < 300000 && diff < bestDiff) {
                    const data = JSON.parse(await fs.readFile(path.join(logDir, file), 'utf-8'));
                    if (data.responseText) {
                        bestMatch = data;
                        bestDiff = diff;
                    }
                }
            }
            if (bestMatch) {
                return res.json({ responseText: bestMatch.responseText, timestamp: bestMatch.timestamp, matchedBy: 'timestamp' });
            }
        }

        res.status(404).json({ error: 'No matching response found' });
    } catch (err) {
        console.error('[Gateway] Recovery error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// app.get('/api/password', async(req, res)=> {
//     if(password === ''){
//         res.send({status: 'unset'})
//     }
//     else if(req.body.password && req.body.password.trim() === password.trim()){
//         res.send({status:'correct'})
//     }
//     else{
//         res.send({status:'incorrect'})
//     }
// })

app.get('/api/test_auth', async(req, res) => {

    if(!password){
        res.send({status: 'unset'})
    }
    else if(!await checkAuth(req, res, true)){
        res.send({status: 'incorrect'})
    }
    else{
        res.send({status: 'success'})
    }
})

let loginTries = 0;
let loginTriesResetsIn = 0;
app.post('/api/login', async (req, res) => {

    if(loginTriesResetsIn < Date.now()){
        loginTriesResetsIn = Date.now() + (30 * 1000); //30 seconds
        loginTries = 0;
    }

    if(loginTries >= 10){
        res.status(429).send({error: 'Too many attempts. Please wait and try again later.'})
        return;
    }
    else{
        loginTries++;
    }

    if(password === ''){
        res.status(400).send({error: 'Password not set'})
        return;
    }
    if(req.body.password && req.body.password.trim() === password.trim()){
        knownPublicKeysHashes.push(await hashJSON(req.body.publicKey))
        res.send({status:'success'})
    }
    else{
        res.status(400).send({error: 'Password incorrect'})
    }
})

app.post('/api/crypto', async (req, res) => {
    try {
        const hash = nodeCrypto.createHash('sha256')
        hash.update(Buffer.from(req.body.data, 'utf-8'))
        res.send(hash.digest('hex'))
    } catch (error) {
        res.status(500).send({ error: 'Crypto operation failed' });
    }
})


app.post('/api/set_password', async (req, res) => {
    if(password === ''){
        password = req.body.password
        writeFileSync(passwordPath, password, 'utf-8')
        res.send({status: 'success'})
    }
    else{
        res.status(400).send("already set")
    }
})

app.get('/api/read', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    const filePath = req.headers['file-path'];
    if (!filePath) {
        console.log('no path')
        res.status(400).send({
            error:'File path required'
        });
        return;
    }

    if(!isHex(filePath)){
        res.status(400).send({
            error:'Invaild Path'
        });
        return;
    }
    try {
        if(!existsSync(path.join(savePath, filePath))){
            res.send();
        }
        else{
            res.setHeader('Content-Type','application/octet-stream');
            res.sendFile(path.join(savePath, filePath));
        }
    } catch (error) {
        next(error);
    }
});

app.get('/api/remove', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    const filePath = req.headers['file-path'];
    if (!filePath) {
        res.status(400).send({
            error:'File path required'
        });
        return;
    }
    if(!isHex(filePath)){
        res.status(400).send({
            error:'Invaild Path'
        });
        return;
    }

    try {
        await fs.rm(path.join(savePath, filePath));
        res.send({
            success: true,
        });
    } catch (error) {
        next(error);
    }
});

app.get('/api/list', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    try {
        const data = (await fs.readdir(path.join(savePath))).map((v) => {
            return Buffer.from(v, 'hex').toString('utf-8')
        })
        res.send({
            success: true,
            content: data
        });
    } catch (error) {
        next(error);
    }
});

app.post('/api/write', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    const filePath = req.headers['file-path'];
    const fileContent = req.body
    if (!filePath || !fileContent) {
        res.status(400).send({
            error:'File path required'
        });
        return;
    }
    if(!isHex(filePath)){
        res.status(400).send({
            error:'Invaild Path'
        });
        return;
    }

    try {
        await fs.writeFile(path.join(savePath, filePath), fileContent);
        res.send({
            success: true
        });
    } catch (error) {
        next(error);
    }
});

const oauthData = {
    client_id: '',
    client_secret: '',
    config: {},
    code_verifier: ''

}
app.get('/api/oauth_login', async (req, res) => {
    const redirect_uri = (new URL (req.url)).host + '/api/oauth_callback'

    if(!redirect_uri){
        res.status(400).send({ error: 'redirect_uri is required' });
        return
    }
    if(!oauthData.client_id || !oauthData.client_secret){
        const discovery = await openid.discovery('https://account.sionyw.com/','','');
        oauthData.config = discovery;

        //oauth dynamic client registration
        //https://datatracker.ietf.org/doc/html/rfc7591

        const serverMeta = discovery.serverMetadata()
        //since we can't find a good library to do this, we will do it manually
        const registrationResponse = await fetch(serverMeta.registration_endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + (serverMeta.registration_access_token || '')
            },
            body: JSON.stringify({
                client_id: oauthData.client_id,
                client_secret: oauthData.client_secret,
                redirect_uris: [redirect_uri],
                response_types: ['code'],
                grant_types: ['authorization_code'],
                scope: 'risuai',
                token_endpoint_auth_method: 'client_secret_basic',
                client_name: 'Risuai Node Server',
            })
        });

        if(registrationResponse.status === 201 || registrationResponse.status === 200){
            const registrationData = await registrationResponse.json();
            oauthData.client_id = registrationData.client_id;
            oauthData.client_secret = registrationData.client_secret;
            discovery.clientMetadata().client_id = oauthData.client_id;
            discovery.clientMetadata().client_secret = oauthData.client_secret;
        }
        else{
            console.error('[Server] OAuth2 dynamic client registration failed:', registrationResponse.statusText);
            res.status(500).send({ error: 'OAuth2 client registration failed' });
            return
        }


        //now lets request

        let code_verifier = openid.randomPKCECodeVerifier();
        let code_challenge = await openid.calculatePKCECodeChallenge(code_verifier);

        oauthData.code_verifier = code_verifier;
        let redirectTo = openid.buildAuthorizationUrl(oauthData.config, {
            redirect_uri,
            code_challenge,
            code_challenge_method: 'S256',
            scope: 'risuai',
        })

        res.redirect(redirectTo.toString());

        return;

    }
    
    res.status(500).send({ error: 'OAuth2 login failed' });
});

app.get('/api/oauth_callback', async (req, res) => {

    //since this is a callback we don't need to check password

    const params = (new URL(req.url, `http://${req.headers.host}`)).searchParams;
    const code = params.get('code');

    if(!code){
        res.status(400).send({ error: 'code is required' });
        return
    }
    if(!oauthData.client_id || !oauthData.client_secret || !oauthData.code_verifier){
        res.status(400).send({ error: 'OAuth2 not initialized' });
        return
    }

    let tokens = await openid.authorizationCodeGrant(
        oauthData.config,   
        getCurrentUrl(),
        {
            pkceCodeVerifier: oauthData.code_verifier,
        },
    )

    fs.writeFileSync(authCodePath, tokens.access_token, 'utf-8')

    res.send(tokens)
            
})

async function getHttpsOptions() {

    const keyPath = path.join(sslPath, 'server.key');
    const certPath = path.join(sslPath, 'server.crt');

    try {
 
        await fs.access(keyPath);
        await fs.access(certPath);

        const [key, cert] = await Promise.all([
            fs.readFile(keyPath),
            fs.readFile(certPath)
        ]);
       
        return { key, cert };

    } catch (error) {
        console.error('[Server] SSL setup errors:', error.message);
        console.log('[Server] Start the server with HTTP instead of HTTPS...');
        return null;
    }
}

async function startServer() {
    try {
      
        const port = process.env.PORT || 6001;
        const httpsOptions = await getHttpsOptions();

        if (httpsOptions) {
            // HTTPS
            https.createServer(httpsOptions, app).listen(port, () => {
                console.log("[Server] HTTPS server is running.");
                console.log(`[Server] https://localhost:${port}/`);
            });
        } else {
            // HTTP
            app.listen(port, () => {
                console.log("[Server] HTTP server is running.");
                console.log(`[Server] http://localhost:${port}/`);
            });
        }
    } catch (error) {
        console.error('[Server] Failed to start server :', error);
        process.exit(1);
    }
}

(async () => {
    await startServer();
})();
