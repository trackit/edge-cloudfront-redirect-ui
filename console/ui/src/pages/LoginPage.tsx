import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Brand from '../components/Brand';
import { IconArrow } from '../components/icons';

/* Login page (visual prototype). In production this is backed by an Amazon
   Cognito User Pool — the front just redirects to / handles the Cognito flow.
   Here, any credentials take you into the console. */
export default function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    navigate('/console');
  };

  return (
    <div className="onboard">
      <div className="login-card">
        <div className="login-brand">
          <Brand />
        </div>

        <h1>Sign in</h1>
        <p className="onboard-sub">Access your EdgeRoute console.</p>

        <form className="onboard-form" onSubmit={submit}>
          <div className="field">
            <label>Email</label>
            <input
              className="input"
              type="email"
              autoFocus
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field">
            <label>
              Password
              <a className="login-forgot" href="#" onClick={(e) => e.preventDefault()}>
                Forgot?
              </a>
            </label>
            <input
              className="input"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <button className="btn btn-primary btn-lg btn-block" type="submit">
            Sign in <IconArrow size={18} />
          </button>
        </form>

        <div className="login-divider">
          <span>or</span>
        </div>
        <button className="btn btn-dark btn-lg btn-block">
          Continue with SSO
        </button>

        <p className="onboard-note">
          Secured by Amazon Cognito · Prototype — any credentials work.
        </p>
        <Link to="/" className="oa-back-home" style={{ display: 'inline-block' }}>
          ← Back to home
        </Link>
      </div>
    </div>
  );
}
