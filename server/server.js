const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 簡單的 SQLite（因為 Railway ephemeral filesystem，所以不實際寫入，只做記憶體）
// 生產環境用 Turso
const players = new Map(); // username -> { ws, balance }
let balances = {}; // username -> balance (記憶體)

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json());

// 初始化玩家餘額
function initPlayer(username) {
    if (!balances[username]) {
        balances[username] = 1000;
    }
}

// API
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, message: '請填寫帳號和密碼' });
    
    initPlayer(username);
    res.json({ success: true, player: { username, balance: balances[username] } });
});

app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, message: '請填寫帳號和密碼' });
    
    if (balances[username] !== undefined) {
        res.json({ success: false, message: '帳號已存在' });
    } else {
        balances[username] = 1000;
        res.json({ success: true, message: '註冊成功！初始金額 1000' });
    }
});

app.get('/api/balance/:username', (req, res) => {
    initPlayer(req.params.username);
    res.json({ balance: balances[req.params.username] });
});

// 遊戲狀態
const currentBets = {}; // username -> { type, amount, number? }
let bettingPhase = false;
let lastResult = null;

// 輪盤顏色
function getColor(num) {
    if (num === 0) return 'green';
    const reds = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
    return reds.includes(num) ? 'red' : 'black';
}

// 廣播
function broadcast(msg) {
    for (const [username, data] of players) {
        if (data.ws.readyState === 1) {
            data.ws.send(JSON.stringify(msg));
        }
    }
}

// 開始下注階段
function startBettingPhase() {
    bettingPhase = true;
    currentBets = {};
    broadcast({ type: 'betting_start', duration: 15000 });
    
    setTimeout(() => {
        spinWheel();
    }, 15000);
}

// 轉輪盤
function spinWheel() {
    bettingPhase = false;
    const result = Math.floor(Math.random() * 37);
    const color = getColor(result);
    lastResult = { result, color };
    
    broadcast({ type: 'spinning' });
    
    setTimeout(() => {
        announceResult(result, color);
    }, 3000);
}

// 公告結果
function announceResult(result, color) {
    const winners = [];
    const losers = [];
    
    for (const [username, bet] of Object.entries(currentBets)) {
        let win = false;
        
        if (bet.type === 'color' && bet.color === color) win = true;
        if (bet.type === 'odd_even') {
            if (bet.choice === 'odd' && result % 2 === 1 && result !== 0) win = true;
            if (bet.choice === 'even' && result % 2 === 0 && result !== 0) win = true;
        }
        if (bet.type === 'number' && bet.number === result) win = true;
        
        if (win) {
            const prize = bet.type === 'number' ? bet.amount * 10 : bet.amount * 2;
            balances[username] = (balances[username] || 1000) + prize;
            winners.push({ username, prize, bet: bet.amount });
        } else {
            balances[username] = (balances[username] || 1000) - bet.amount;
            losers.push({ username, amount: bet.amount });
        }
    }
    
    broadcast({
        type: 'result',
        result,
        color,
        winners,
        losers
    });
    
    setTimeout(() => {
        if (players.size > 0) startBettingPhase();
    }, 5000);
}

// WebSocket
wss.on('connection', (ws) => {
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            
            if (msg.type === 'join') {
                const username = msg.username;
                initPlayer(username);
                players.set(username, { ws, balance: balances[username] });
                ws._username = username;
                
                ws.send(JSON.stringify({ type: 'joined', balance: balances[username] }));
                
                if (!bettingPhase) startBettingPhase();
            }
            
            if (msg.type === 'bet') {
                const username = msg.username;
                if (!bettingPhase || currentBets[username]) return; // 已經下注過
                
                currentBets[username] = {
                    type: msg.betType,
                    amount: parseInt(msg.amount),
                    color: msg.color,
                    choice: msg.choice,
                    number: msg.number
                };
                
                broadcast({ type: 'bets_update', bets: currentBets });
            }
        } catch(e) {
            console.log('錯誤:', e.message);
        }
    });
    
    ws.on('close', () => {
        if (ws._username) players.delete(ws._username);
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log('🎰 T-LO 俄羅斯輪盤啟動! http://localhost:' + PORT);
});