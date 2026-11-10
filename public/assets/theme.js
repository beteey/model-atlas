// 在首屏绘制前套用已保存的外观，避免闪一下。普通脚本，放在 <head> 里同步执行。
(function () {
  try {
    var saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  } catch (error) { /* 隐私模式下读不到存储，跟随系统即可 */ }
})();
