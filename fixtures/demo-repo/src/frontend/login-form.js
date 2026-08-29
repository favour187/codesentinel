


const { login } = require('../routes/auth');

function renderLoginForm(container, state) {

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
