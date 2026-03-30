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
const DEPARTMENTS = [
    {
        key: 'backend', label: 'Backend', color: '#fb923c',
        members: [
            { login: 'pz',  name: 'Павел Ж.',   fullName: 'Павел Журавлев',    avatar: 'ПЖ', gender: 'm', lead: true,  deskItems: ['plant'] },
            { login: 'hb',  name: 'Булат Х.',   fullName: 'Булат Хайрутдинов', avatar: 'БХ', gender: 'm', lead: false, deskItems: ['coffee'] },
            { login: 'uk',  name: 'Юлия К.',    fullName: 'Юлия Королева',     avatar: 'ЮК', gender: 'f', seed: 'Yulia2', lead: false, deskItems: ['plant', 'coffee'] },
        ],
    },
    {
        key: 'frontend', label: 'Frontend', color: '#22d3ee',
        members: [
            { login: 'nk',  name: 'Никита К.',   fullName: 'Коробочкин Никита', avatar: 'НК', gender: 'm', lead: true,  deskItems: ['headphones', 'coffee'] },
            { login: 'ap',  name: 'Алексей П.',  fullName: 'Алексей Поляков',   avatar: 'АП', gender: 'm', lead: false, deskItems: ['cat'] },
        ],
    },
    {
        key: 'qa', label: 'QA', color: '#c084fc',
        members: [
            { login: 'mp',  name: 'Павел М.',   fullName: 'Павел Маслаков',    avatar: 'ПМ', gender: 'm', lead: true,  deskItems: ['coffee'] },
        ],
    },
    {
        key: 'design', label: 'Дизайн', color: '#f472b6',
        members: [
            { login: 'sav', name: 'Анастасия С.', fullName: 'Анастасия Сушкова', avatar: 'АС', gender: 'f', lead: true, deskItems: ['plant', 'coffee'] },
        ],
    },
];

// Flat list for API queries
const TEAM = DEPARTMENTS.flatMap(dept =>
    dept.members.map(m => ({ ...m, role: dept.key, roleLabel: dept.label, color: dept.color, department: dept.key }))
);

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

    // Build response grouped by departments
    const sortTasks = (tasks) => tasks.sort((a, b) => {
        const pri = { inProgress: 0, review: 1, testing: 2, paused: 3 };
        return (pri[a.status] ?? 9) - (pri[b.status] ?? 9);
    });

    return DEPARTMENTS.map(dept => ({
        key: dept.key,
        label: dept.label,
        color: dept.color,
        members: dept.members.map(member => ({
            name: member.name,
            fullName: member.fullName,
            role: dept.key,
            roleLabel: dept.label,
            avatar: member.avatar,
            avatarUrl: member.gender === 'f'
                ? `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(member.seed || member.fullName)}&skinColor=f5d0c5&beardProbability=0&hair=long01,long02,long03,long04,long05,long06,long07,long08,long09,long10,long11,long12,long13,long14`
                : `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(member.seed || member.fullName)}&skinColor=f5d0c5&beardProbability=20&hair=short01,short02,short03,short04,short05`,
            color: dept.color,
            lead: member.lead,
            deskItems: member.deskItems,
            tasks: sortTasks(tasksByLogin[member.login] || []),
        })),
    }));
}

// ===== Polling schedule =====
function getRefreshInterval() {
    const now = new Date();
    const day = now.getDay();        // 0=Sun, 6=Sat
    const hour = now.getHours();
    const isWeekend = day === 0 || day === 6;

    if (isWeekend)                     return 3_600_000;  // weekends: 1h
    if (hour >= 9 && hour < 20)        return 60_000;     // workday 9-20: 1min
    if ((hour >= 7 && hour < 9) ||
        (hour >= 20 && hour < 23))     return 600_000;    // shoulder hours: 10min
    return 3_600_000;                                     // night (23-7): 1h
}

// ===== Cache =====
let cache = { data: null, updatedAt: null };

async function getTeamData() {
    const now = Date.now();
    const ttl = getRefreshInterval();
    if (cache.data && cache.updatedAt && (now - cache.updatedAt) < ttl) {
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
        res.json({ departments: data, updatedAt, refreshInterval: getRefreshInterval() });
    } catch (err) {
        res.status(502).json({ error: 'Failed to fetch tracker data', details: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`GetMeBack HQ running at http://localhost:${PORT}`);
});
