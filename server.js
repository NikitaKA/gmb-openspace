const express = require('express');
const path = require('path');
const fs = require('fs');

// ===== Load .env manually (no extra deps) =====
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const [key, ...rest] = trimmed.split('=');
        process.env[key.trim()] = rest.join('=').trim();
    });
}

const TRACKER_TOKEN = process.env.TRACKER_OAUTH_TOKEN;
const TRACKER_ORG = process.env.TRACKER_ORG_ID;
const PORT = process.env.PORT || 3000;

if (!TRACKER_TOKEN || !TRACKER_ORG) {
    console.error('Missing TRACKER_OAUTH_TOKEN or TRACKER_ORG_ID in .env');
    process.exit(1);
}

// ===== Team config =====
const TEAM = [
    { login: 'nk',  name: 'Никита К.',     fullName: 'Коробочкин Никита',  role: 'frontend', roleLabel: 'Frontend', avatar: 'НК', color: '#22d3ee', deskItems: ['headphones', 'coffee'] },
    { login: 'hb',  name: 'Булат Х.',      fullName: 'Булат Хайрутдинов',  role: 'backend',  roleLabel: 'Backend',  avatar: 'БХ', color: '#fb923c', deskItems: ['coffee'] },
    { login: 'uk',  name: 'Юлия К.',       fullName: 'Юлия Королева',      role: 'backend',  roleLabel: 'Backend',  avatar: 'ЮК', color: '#fb923c', deskItems: ['plant', 'coffee'] },
    { login: 'ap',  name: 'Алексей П.',    fullName: 'Алексей Поляков',    role: 'frontend', roleLabel: 'Frontend', avatar: 'АП', color: '#22d3ee', deskItems: ['cat'] },
    { login: 'pz',  name: 'Павел Ж.',      fullName: 'Павел Журавлев',     role: 'backend',  roleLabel: 'Backend',  avatar: 'ПЖ', color: '#fb923c', deskItems: ['plant'] },
    { login: 'mp',  name: 'Павел М.',      fullName: 'Павел Маслаков',     role: 'qa',       roleLabel: 'QA',       avatar: 'ПМ', color: '#c084fc', deskItems: ['coffee'] },
    { login: 'sav', name: 'Анастасия С.',  fullName: 'Анастасия Сушкова',  role: 'design',   roleLabel: 'Дизайн',   avatar: 'АС', color: '#f472b6', deskItems: ['plant', 'coffee'] },
];

const QUEUE = 'DEV';
const STATUSES = 'В работе, Тестируется, Ревью, В ревью, Ожидает ревью, На паузе';

// ===== Tracker API =====
const TRACKER_BASE = 'https://api.tracker.yandex.net/v2';

async function trackerFetch(endpoint, options = {}) {
    const url = `${TRACKER_BASE}${endpoint}`;
    const res = await fetch(url, {
        ...options,
        headers: {
            'Authorization': `OAuth ${TRACKER_TOKEN}`,
            'X-Org-Id': TRACKER_ORG,
            'Content-Type': 'application/json',
            ...options.headers,
        },
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Tracker API ${res.status}: ${text}`);
    }
    return res.json();
}

function mapStatus(trackerStatus) {
    const key = trackerStatus?.key;
    if (key === 'inProgress') return 'inProgress';
    if (key === 'testing') return 'testing';
    if (key === 'inReview' || key === 'inthereview' || key === 'awaitingreview') return 'review';
    if (key === 'onPause') return 'paused';
    return 'paused';
}

async function fetchTeamTasks() {
    const logins = TEAM.map(m => m.login);
    const statusKeys = ['inProgress', 'testing', 'inReview', 'inthereview', 'awaitingreview', 'onPause'];

    const issues = await trackerFetch('/issues/_search?perPage=200', {
        method: 'POST',
        body: JSON.stringify({
            filter: {
                queue: QUEUE,
                assignee: logins,
                status: statusKeys,
            },
        }),
    });

    // Group by assignee login
    const tasksByLogin = {};
    for (const issue of issues) {
        const assigneeUid = issue.assignee?.id;
        // Find login by matching display name or UID
        let login = null;
        for (const member of TEAM) {
            // Match by display name containing member's fullName parts
            const display = issue.assignee?.display || '';
            if (display.includes(member.fullName.split(' ')[0]) && display.includes(member.fullName.split(' ').pop())) {
                login = member.login;
                break;
            }
        }
        if (!login) continue;

        if (!tasksByLogin[login]) tasksByLogin[login] = [];
        tasksByLogin[login].push({
            key: issue.key,
            summary: issue.summary?.replace(/\s*-\s*\[.*?\]\s*$/, '').trim() || '',
            status: mapStatus(issue.status),
        });
    }

    // Build response matching frontend structure
    return TEAM.map(member => ({
        name: member.name,
        fullName: member.fullName,
        role: member.role,
        roleLabel: member.roleLabel,
        avatar: member.avatar,
        color: member.color,
        deskItems: member.deskItems,
        tasks: (tasksByLogin[member.login] || []).sort((a, b) => {
            const pri = { inProgress: 0, review: 1, testing: 2, paused: 3 };
            return (pri[a.status] ?? 9) - (pri[b.status] ?? 9);
        }),
    }));
}

// ===== Cache =====
let cache = { data: null, updatedAt: null };
const CACHE_TTL = 60_000; // 1 minute

async function getTeamData() {
    const now = Date.now();
    if (cache.data && cache.updatedAt && (now - cache.updatedAt) < CACHE_TTL) {
        return cache;
    }
    try {
        const data = await fetchTeamTasks();
        cache = { data, updatedAt: now };
    } catch (err) {
        console.error('Failed to fetch from Tracker:', err.message);
        // Return stale cache if available
        if (cache.data) return cache;
        throw err;
    }
    return cache;
}

// ===== Express =====
const app = express();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/team', async (req, res) => {
    try {
        const { data, updatedAt } = await getTeamData();
        res.json({ team: data, updatedAt });
    } catch (err) {
        res.status(502).json({ error: 'Failed to fetch tracker data', details: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`GetMeBack HQ running at http://localhost:${PORT}`);
});
