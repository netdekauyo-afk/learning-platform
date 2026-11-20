/* One source of Numbas bootstrapping for all Classroom exercise pages. */
const host = document.querySelector("#numbas-host");
const status = document.querySelector("#numbas-status");
const engine = new URL("./engine/", import.meta.url);
const resource = (path) => new URL(path, engine).href;

const translations = {
  "question.submit part": "答え合わせ",
  "question.answer saved": "確認済み",
  "part.input title": "{{name}}の答え",
  "part.feedback": "採点の詳細",
  "part.correct answer": "正しい答え",
  "part.correct answer title": "{{name}}の正しい答え",
  "question.score feedback.score total actual": "{{score,niceNumber}} / {{marks,niceNumber}} 点",
  "question.nav.label": "問題の操作",
  "control.style options": "表示設定",
  "modal.confirm": "確認",
  "modal.ok": "確認",
};
async function boot() {
  if (!host || !host.dataset.examSource) throw new Error("問題の参照先が設定されていません。");
  const response = await fetch(resource("template.html"));
  if (!response.ok) throw new Error("Numbasの画面テンプレートを取得できませんでした。");
  const templateHost = document.createElement("div");
  templateHost.innerHTML = (await response.text()).replaceAll(
    "numbas-runtime/", resource("numbas-runtime/")
  );
  const template = templateHost.querySelector("#numbas-exam-template");
  if (!template) throw new Error("Numbasの画面テンプレートが見つかりません。");
  document.body.appendChild(template);

  await customElements.whenDefined("numbas-exam");
  await window.Numbas.init_promise;
  window.Numbas.display.control_focus = false;
  window.Numbas.locale.set_preferred_locale("ja-JP");
  window.i18next.addResourceBundle("ja-jp", "translation", translations, true, true);
  await window.i18next.changeLanguage("ja-jp");

  const exam = document.createElement("numbas-exam");
  exam.setAttribute("noload", "");
  exam.setAttribute("source_url", host.dataset.examSource);
  exam.setAttribute("scorm", "false");
  exam.addEventListener("numbas:loaded", () => {
    status.textContent = "";
  }, { once: true });
  host.replaceChildren(exam);

  const styles = [
    resource("numbas-runtime/numbas.css"),
    new URL("./theme.css", import.meta.url).href,
  ];
  await Promise.all(styles.map((href) => new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.onload = resolve;
    link.onerror = () => reject(new Error("Numbasのスタイルを読み込めませんでした。"));
    exam.shadowRoot.appendChild(link);
  })));
  await exam.load_exam();
}
boot().catch((error) => {
  console.error(error);
  status.textContent = "問題を表示できませんでした。";
});
