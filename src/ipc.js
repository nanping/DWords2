const { DICTIONARIES } = require("./common");
const { getUserDB, getDictDB } = require("./database");
const { getWinByWebContentsID, getMainWin, getSys, setSys, genUUID, parseCSV } = require("./utils");
const settings = require('./settings');
const { synchronize } = require("./sync");
const { dialog, app } = require("electron");
const { readFile } = require("fs/promises");
const path = require('path');


function close(event) {
    const win = getWinByWebContentsID(event.sender.id);
    win.hide();
}

function setIgnoreMouseEvents(event, ignore, options) {
    const win = getWinByWebContentsID(event.sender.id);
    win.setIgnoreMouseEvents(ignore, options);
}

function setWinSize(event, width, height) {
    const win = getWinByWebContentsID(event.sender.id);
    win.setMinimumSize(width, height);
    win.setSize(width, height);
}

function moveWin(event, dx, dy) {
    const win = getWinByWebContentsID(event.sender.id);
    const [x, y] = win.getPosition();
    win.setPosition(x + dx, y + dy);
    event.returnValue = true;
}

async function getPlans() {
    return await getUserDB().all(`select * from plans where not deleted`);
}

async function getCurrentPlan() {
    return await getSys('currentPlan');
}

async function getWords(_, planID) {
    return await getUserDB().all(`select * from words
        where not deleted and plan_id = ? order by time`, planID);
}

async function selectPlan(_, planID) {
    await setSys('currentPlan', planID);
}

const importFields = [
    { name: 'word', parse: w => w },
    { name: 'paraphrase', parse: p => p },
];

async function importCSV(id, plan) {
    const data = await readFile(plan.path, {encoding: 'utf8'});
    const dictID = await settings.getSetting('dictionary');
    const { table, field } = DICTIONARIES[dictID]

    let i = 0;
    for (let {word, paraphrase} of parseCSV(importFields, data)) {
        if (!word) continue;
        if (!paraphrase) {
            const res = await getDictDB().get(`select ${field} as paraphrase
                from ${table} where word = ?`, word);
            paraphrase = res ? res.paraphrase : '';
        }
        await getUserDB().run(`insert or ignore into words
            (plan_id, word, time, paraphrase, version) values (?, ?, ?, ?, ?)`,
            id, word, ++i, paraphrase, Date.now());
    }
}

const planInitializers = {
    async library(id, plan) {
        const dict = DICTIONARIES[plan.dict];
        const tag = `%${plan.tag}%`;
        const words = await getDictDB().all(`
            select word, row_number() over () as time, ${dict.field} as paraphrase
            from ${dict.table} where tag like ? order by ${plan.order}`, tag);

        const now = Date.now();
        for ({word, time, paraphrase} of words) {
            await getUserDB().run(`insert into words
                (plan_id, word, time, paraphrase, version) values (?, ?, ?, ?, ?)`,
                id, word, time, paraphrase, now);
        }
    },

    async import_(id, plan) {
        const planPath = plan.path;
        if (planPath.endsWith('.csv')) {
            await importCSV(id, plan);
        } else {
            throw new Error('Unsupported file type');
        }
    },
};

async function newPlan(_, plan) {
    const planID = genUUID();
    await getUserDB().run(`insert into plans (id, name, version) values (?, ?, ?)`,
        planID, plan.name, Date.now());

    try {
        const init = planInitializers[plan.type];
        if (init) {
            await init(planID, plan);
        }
    } catch (e) {
        await getUserDB().run(`delete from plans where id = ?`, planID);
        return {err: e};
    }

    if (!await getCurrentPlan()) {
        await selectPlan(_, planID);
    }

    return {id: planID};
}

async function renamePlan(_, id, name) {
    await getUserDB().run(`update plans set name = ?, version = ? where id = ?`,
        name, Date.now(), id);
}

async function delPlan(_, id) {
    await getUserDB().run(`update plans set
        deleted = true, version = ? where id = ?`, Date.now(), id);
    await getUserDB().run(`delete from words where plan_id = ?`, id);
    if (await getCurrentPlan() === id) {
        const newPlan = await getUserDB().get(`select id from plans where not deleted limit 1`);
        await selectPlan(_, newPlan ? newPlan.id : null);
    }
}

async function addWord(_, planID, word, time, paraphrase) {
    const w = await getUserDB().get(`select * from words
        where plan_id = ? and word = ? and not deleted`, planID, word);
    if (w) {
        return false;
    }

    await getUserDB().run(`insert or replace into words
        (plan_id, word, time, paraphrase, version) values (?, ?, ?, ?, ?)`,
        planID, word, time, paraphrase, Date.now());

    return true;
}

async function getWordList(_, tab) {
    const planId = await getCurrentPlan();
    const maxCurrent = await settings.getSetting('maxCurrent');
    let ans
    switch (tab) {
        case "Current":
            ans = await getUserDB().all(`select * from words
                where plan_id = ? and status = 0 and not deleted order by time limit ?`,
                planId, maxCurrent);
            break;
        case "Planning":
            ans = await getUserDB().all(`select * from words
                where plan_id = ? and status = 0 and not deleted order by time limit -1 offset ?`,
                planId, maxCurrent);
            break;
        case "Memorized":
            ans = await getUserDB().all(`select * from words
                where plan_id = ? and status = 1 and not deleted order by time`,
                planId);
            break;
        case "All":
            ans = await getUserDB().all(`select * from words
                where plan_id = ? and not deleted order by time`, planId);
            break;
    }
    return ans;
}

async function updateWord(_, planID, word, data) {
    data.version = Date.now();
    if (data.word && word !== data.word) { // rename the word
        // if the new word already exists in the table but marked as deleted, then remove it
        await getUserDB().run(`delete from words
            where plan_id = ? and word = ? and deleted`, planID, data.word);

        // copy the word to the new name
        const st = await getUserDB().run(`insert or ignore into words
            (plan_id, word, time, paraphrase, show_paraphrase, color, status)
            select plan_id, ?, time, paraphrase, show_paraphrase, color, status
            from words where plan_id = ? and word = ?`,
            data.word, planID, word);
        if (st.changes === 0) { // copy failed, means the new word already exists
            return 'duplicated-new-word';
        }

        // mark the old word as deleted
        await getUserDB().run(`update words set deleted = true, version = ?
            where plan_id = ? and word = ?`, data.version, planID, word);

        word = data.word;
    }

    const fields = [];
    const values = [];
    for (const field in data) {
        if (field !== 'word' && field !== 'plan_id') {
            fields.push(`${field} = ?`);
            values.push(data[field]);
        }
    }

    await getUserDB().run(`update words set ${fields.join(', ')} where word = ? and plan_id = ?`,
        ...values, word, planID);

    if ('status' in data) {
        getMainWin().webContents.send('refreshList');
    }
}

async function delWord(_, planID, word) {
    await getUserDB().run(`update words set
        deleted = true, version = ? where plan_id = ? and word = ?`,
        Date.now(), planID, word);
}

async function consultDictionary(_, word) {
    const id = await settings.getSetting('dictionary');
    const dict = DICTIONARIES[id]
    return await getDictDB().get(`select *, ${dict.field} as paraphrase from ${dict.table} where word = ?`, word);
}

async function getSettings(_, ...keys) {
    return await settings.getSettings(...keys);
}

async function updateSettings(_, s) {
    return await settings.updateSettings(this, s);
}

async function getWordsByPrefix(_, prefix) {
    const id = await settings.getSetting('dictionary');
    const dict = DICTIONARIES[id]
    const res = await getDictDB().all(`select word from ${dict.table} where word like ? limit 100`, `${prefix}%`);
    return res.map(({word}) => word);
}

function toggleDevTools() {
    getMainWin().webContents.toggleDevTools();
}

async function sync() {
    try {
        await synchronize(this);
    } catch(e) {
        console.log('sync err', e);
        return e;
    }
}

async function importPlan() {
    const file = await dialog.showOpenDialog(getMainWin(), {
        title: 'Import plan',
        properties: ['openFile'],
        filters: [{extensions: ['csv']}],
    });
    if (file.filePaths.length > 0) {
        return file.filePaths[0];
    }
}

async function showAbout() {
    await dialog.showMessageBox(getMainWin(), {
        type: 'info',
        title: 'About DWords',
        icon: path.join(__dirname, '../assets/img/logo.png'),
        message: 'DWords',
        detail: [
            `Version: ${app.getVersion()}`,
            `Copyright (C) 2021, Luyu Huang`
        ].join('\n'),
        buttons: ['OK'],
    });
}

function exit() {
    app.quit();
}

module.exports = {
    close, setIgnoreMouseEvents, setWinSize, moveWin, getPlans, getCurrentPlan,
    getWords, selectPlan, newPlan, renamePlan, delPlan, addWord, getWordList,
    updateWord, delWord, consultDictionary, getSettings, updateSettings, getWordsByPrefix,
    toggleDevTools, sync, importPlan, showAbout, exit,
}
