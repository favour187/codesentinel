// DEMO FIXTURE — frontend component with an intentional XSS sink.
// Planted: innerHTML with untrusted input (CWE-79).

const { login } = require('../routes/auth');

function renderLoginForm(container, state) {
  // Unescaped interpolation of a server-supplied error message into innerHTML.
  container.innerHTML = `
    <form id="login">
      <input name="email" value="${state.email}" />
      <input name="password" type="password" />
      <div class="error">${state.error}</div>
      <button type="submit">Sign in</button>
    </form>
  `;
}

function handleSubmit(event, container) {
  event.preventDefault();
  const form = event.target;
  const result = login({ body: { username: form.email.value, password: form.password.value } }, {
    json: (data) => data,
    status: () => ({ send: (msg) => msg }),
  });
  renderLoginForm(container, { email: form.email.value, error: result ? '' : 'Invalid credentials' });
  return result;
}

module.exports = { renderLoginForm, handleSubmit };
