// NewAPI 签到 · 主题预置（外部脚本，满足扩展 CSP 'self'，避免内联被拦截）
(function(){
  try{
    var t = localStorage.getItem('nacheckin.theme');
    if (t !== 'light' && t !== 'dark') {
      t = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
