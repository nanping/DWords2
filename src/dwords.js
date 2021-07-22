const { app, BrowserWindow, ipcMain, Tray, Menu, screen } = require('electron');

function initDWords() {
    const dwords = {};

    setIPC();
    setAppEvents();
    createMainWindow();

    dwords.tray = setTray();
    dwords.danmakuLauncher = setDanmakuLauncher(5000);
    dwords.danmakuMover = setDanmakuMover(0.1);

    return dwords;
}

function setAppEvents() {
    app.on('activate', showWindow);
    app.on('window-all-closed', () => {})
}

function createMainWindow() {
    const mainWindow = new BrowserWindow({
        width: 900,
        height: 600,
        minWidth: 580,
        minHeight: 420,
        frame: false,
        title: 'DWords',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        }
    });

    mainWindow.loadFile('dist/home.html');
}

async function createDanmaku(word) {
    const danmaku = new BrowserWindow({
        show: false,
        useContentSize: true,
        resizable: false,
        alwaysOnTop: true,
        frame: false,
        transparent: true,
        backgroundColor: '#00ffffff',
        hasShadow: false,
        alwaysOnTop: true,
        title: 'Danmaku',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        }
    });

    await danmaku.loadFile('dist/danmaku.html', { query: word });
    danmaku.setSkipTaskbar(true);
    danmaku.setMenu(null);
    danmaku.showInactive();

    const screenSize = screen.getPrimaryDisplay().size;
    const x = screenSize.width;
    const y = Math.floor(Math.random() * screenSize.height / 3);

    danmaku.setPosition(x, y);
    // danmaku.webContents.openDevTools()
}

function showWindow() {
    const mainWindow = BrowserWindow.getAllWindows().find(win => win.getTitle() === 'DWords')
    if (mainWindow) {
        mainWindow.show();
    } else {
        createMainWindow();
    }
}

function setTray() {
    const tray = new Tray('assets/img/logo@2x.png');
    tray.setToolTip('DWords');
    tray.setContextMenu(Menu.buildFromTemplate([
        {
            label: 'Exit',
            click() {
                app.quit();
            }
        }
    ]));
    tray.on('click', showWindow);
    return tray;
}

function getWinByWebContentsID(id) {
    return BrowserWindow.getAllWindows().find(win => win.webContents.id === id)
}

function setIPC() {
    ipcMain.on('close', (event) => {
        const win = getWinByWebContentsID(event.sender.id);
        win.hide();
    });

    ipcMain.on('setIgnoreMouseEvents', (event, ignore, options) => {
        const win = getWinByWebContentsID(event.sender.id);
        win.setIgnoreMouseEvents(ignore, options);
    });

    ipcMain.on('setWinSize', (event, width, height) => {
        const win = getWinByWebContentsID(event.sender.id);
        win.setMinimumSize(width, height);
        win.setSize(width, height);
    });

    ipcMain.on('moveWin', (event, dx, dy) => {
        const win = getWinByWebContentsID(event.sender.id);
        const [x, y] = win.getPosition();
        win.setPosition(x + dx, y + dy);
        event.returnValue = true;
    })
}

const words = [
  {
    word: 'syndicate',
    paraphrase: '企业联合',
    showParaphrase: false,
    color: 'dark',
  },
  {
    word: 'apple',
    paraphrase: '苹果',
    showParaphrase: false,
    color: 'red',
  },
  {
    word: 'convene',
    paraphrase: '集合',
    showParaphrase: false,
    color: 'orange',
  }
]

function setDanmakuLauncher(interval) {
    return setInterval(() => {
        createDanmaku(words[Math.floor(Math.random() * words.length)]);
    }, interval);
}

function setDanmakuMover(speed) {
    let last = new Date().valueOf();
    return setInterval(() => {
        const now = new Date().valueOf();
        const dis = Math.round((now - last) * speed);
        last = now;
        BrowserWindow.getAllWindows().forEach((win) => {
            if (win.getTitle() !== 'Danmaku') return;
            const [x, y] = win.getPosition();
            if (x < 0) {
                win.close();
            } else {
                win.setPosition(x - dis, y);
            }
        });
    }, 20);
}

module.exports = {
    initDWords,
};