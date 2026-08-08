const { invoke } = window.__TAURI__.core;

let greetInputEl;
let greetMsgEl;

async function greet() {
  greetMsgEl.textContent = await invoke("greet", { name: greetInputEl.value });
}

window.addEventListener("DOMContentLoaded", async () => {
  greetInputEl = document.querySelector("#greet-input");
  greetMsgEl = document.querySelector("#greet-msg");
  document.querySelector("#greet-form").addEventListener("submit", (e) => {
    e.preventDefault();
    greet();
  });
  const status = await invoke("get_app_status");
  document.querySelector("#status").textContent = status;
  document.querySelector("#url-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = document.querySelector("#sso-result");
    const url = document.querySelector("#url-input").value;
    try {
      await invoke("open_sso_window", { url });
      out.textContent = "SSO window open"; 
    } catch (err) {
      out.textContent = "Error" + err;
    } 
  })
});
