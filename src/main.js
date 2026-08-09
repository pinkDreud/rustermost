const { invoke } = window.__TAURI__.core;

window.addEventListener("DOMContentLoaded", async () => {
  const status = await invoke("get_app_status");
  
  document.querySelector("#status").textContent = status;

  document.querySelector("#url-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = document.querySelector("#sso-result");
    const url = document.querySelector("#url-input").value;
    try {
      await invoke("open_sso_window", { url });
      out.textContent = "Login in corso nella finestra SSO...";

      const timer = setInterval(async () => {
        try {
          const token = await invoke("capture_token", { url });
          clearInterval(timer);
          out.textContent = "Token catturato! " + token.slice(0, 8) + "...";
        } catch (_) { /* token non ancora presente: riprovo al giro dopo */ }
      }, 2000);
    } catch (err) {
      out.textContent = "Errore: " + err;
    }
});
});
