// Ponte mínima: a página sabe que está no aplicativo de computador (sem acesso ao Node).
const { contextBridge } = require("electron");
contextBridge.exposeInMainWorld("HELSIM_DESKTOP", { platform: process.platform, version: "1.0.0" });
