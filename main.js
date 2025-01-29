const { app, BrowserWindow } = require('electron');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 800,
    height: 600,
    autoHideMenuBar: true,
    show: false, // Initially hide the window
    frame: false, // Hide the window frame
    icon: "icon.png",
    webPreferences: {
      backgroundThrottling: false,
    },
  });

  // Maximize the window
  win.maximize();

  // Load the Flyff Universe URL
  win.loadURL('https://universe.flyff.com/play');

  // Show the window once the content is ready
  win.once('ready-to-show', () => {
    win.show();
  });

  // Optional: Handle window closed event
  win.on('closed', () => {
    win = null;
  });
}

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (win === null) {
    createWindow();
  }
});
