/* Load the already-proven MathJax configuration used by Classroom's Numbas engine. */
(function() {
  const engine = new URL("./engine/", document.currentScript.src);
  window.MathJax = {
    tex: { packages: { "[+]": ["numbas", "texhtml"] }, allowTexHTML: true },
    loader: {
      load: ["[numbas]/numbas-mathjax.js", "[tex]/texhtml"],
      paths: { numbas: new URL("numbas-runtime/scripts/standalone_scripts", engine).href },
      versionWarnings: false,
    },
  };
})();
