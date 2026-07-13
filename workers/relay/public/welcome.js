const loading = document.querySelector("[data-welcome-loading]");
const success = document.querySelector("[data-welcome-success]");
const failure = document.querySelector("[data-welcome-error]");
const token = new URLSearchParams(location.hash.slice(1)).get("token");

if (token) history.replaceState(null, "", "/welcome");

async function completeSignIn() {
  if (!token) {
    show(failure);
    return;
  }
  try {
    const response = await fetch("/v1/auth/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) throw new Error("invalid_token");
    const result = await response.json();
    const sessionOutput = document.querySelector("[data-session-token]");
    if (!(sessionOutput instanceof HTMLElement) || typeof result.session !== "string") throw new Error("invalid_response");
    sessionOutput.textContent = result.session;
    const copy = document.querySelector("[data-copy-session]");
    copy?.addEventListener("click", async () => {
      await navigator.clipboard.writeText(result.session);
      copy.textContent = "Copied";
    });
    show(success);
  } catch {
    show(failure);
  }
}

function show(element) {
  if (loading instanceof HTMLElement) loading.hidden = true;
  if (element instanceof HTMLElement) element.hidden = false;
}

void completeSignIn();
