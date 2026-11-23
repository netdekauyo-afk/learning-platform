(function () {
  var back = document.getElementById("summary-back");
  if (!back) return;
  back.addEventListener("click", function (event) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    try {
      var ref = new URL(document.referrer);
      var list = new URL("../../", window.location.href);
      if (ref.origin === list.origin &&
          (ref.pathname === list.pathname || ref.pathname === list.pathname + "index.html") &&
          window.history.length > 1) {
        event.preventDefault();
        window.history.back();
      }
    } catch (error) { /* 直接開いた場合は一覧へ移動する */ }
  });
})();
