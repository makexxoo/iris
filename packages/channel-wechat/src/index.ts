export { WechatAdapter, type WechatConfig, type WechatChannelGroup } from './adapter.js';
export { AccountConnection, type PolicyMode, type WechatAccountConfig } from './account-connection.js';
export {
  fetchQrCode,
  pollQrStatusOnce,
  runQrLogin,
  saveCredential,
  loadCredential,
  listSavedAccounts,
  defaultDataDir,
  type QrCodeInfo,
  type WechatCredential,
  type QrLoginOptions,
  type QrPollStatus,
} from './qr-login.js';
