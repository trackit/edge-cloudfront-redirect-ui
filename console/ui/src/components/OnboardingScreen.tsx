import { useState } from 'react';
import { Link } from 'react-router-dom';
import Brand from './Brand';
import DistributionFields from './DistributionFields';
import { SAMPLE_DISTRIBUTION } from '../mockData';
import type { Distribution } from '../types';
import { IconArrow, IconServer, IconSliders, IconBolt } from './icons';

interface Props {
  onConnect: (d: Distribution) => void;
}

const STEPS = [
  {
    icon: <IconServer size={16} />,
    title: 'Connect',
    desc: 'Point EdgeRoute at your CloudFront distribution and its DynamoDB table.',
  },
  {
    icon: <IconSliders size={16} />,
    title: 'Add rules',
    desc: 'Create redirects and rewrites per host — no code, no redeploy.',
  },
  {
    icon: <IconBolt size={16} />,
    title: 'Go live',
    desc: 'Changes reach the edge in about a minute.',
  },
];

/* First-run onboarding — a soft welcome step, then the connect form.
   Escape hatches: explore with sample data, or go back to the landing page. */
export default function OnboardingScreen({ onConnect }: Props) {
  const [step, setStep] = useState<'welcome' | 'connect'>('welcome');
  const [d, setD] = useState<Distribution>({
    distributionId: '',
    tableName: '',
    region: 'us-east-1',
  });

  const valid = d.distributionId.trim() !== '' && d.tableName.trim() !== '';

  return (
    <div className="onboard">
      <div className="onboard-shell">
        {/* left — welcome / context */}
        <aside className="onboard-aside">
          <Brand />
          <h2 className="oa-title">
            Redirects &amp; rewrites,
            <br />
            without touching code.
          </h2>
          <ul className="oa-steps">
            {STEPS.map((s, i) => (
              <li key={s.title}>
                <span className="oa-step-ico">{s.icon}</span>
                <span>
                  <span className="oa-step-title">
                    {i + 1}. {s.title}
                  </span>
                  <span className="oa-step-desc">{s.desc}</span>
                </span>
              </li>
            ))}
          </ul>
          <Link to="/" className="oa-back-home">
            ← Back to home
          </Link>
        </aside>

        {/* right — action */}
        <div className="onboard-main">
          {step === 'welcome' ? (
            <div className="onboard-welcome">
              <span className="wave">👋</span>
              <h1>Welcome to EdgeRoute</h1>
              <p className="onboard-sub">
                Let's connect your first distribution — or jump straight in with
                sample data to look around.
              </p>
              <div className="onboard-welcome-actions">
                <button
                  className="btn btn-primary btn-lg btn-block"
                  onClick={() => setStep('connect')}
                >
                  Connect a distribution <IconArrow size={18} />
                </button>
                <button
                  className="btn btn-dark btn-lg btn-block"
                  onClick={() => onConnect(SAMPLE_DISTRIBUTION)}
                >
                  Explore with sample data
                </button>
              </div>
              <p className="onboard-note">
                Prototype — nothing is sent to AWS. You can change everything
                later in Settings.
              </p>
            </div>
          ) : (
            <div className="onboard-connect">
              <button
                className="oa-back"
                onClick={() => setStep('welcome')}
                type="button"
              >
                ← Back
              </button>
              <h1>Connect your distribution</h1>
              <p className="onboard-sub">
                The CloudFront distribution EdgeRoute is attached to, and the
                DynamoDB table that stores its rules.
              </p>

              <div className="onboard-form">
                <DistributionFields
                  value={d}
                  onChange={(patch) => setD((prev) => ({ ...prev, ...patch }))}
                />
              </div>

              <div className="onboard-actions">
                <button
                  className="btn btn-ghost"
                  onClick={() => setD(SAMPLE_DISTRIBUTION)}
                  type="button"
                >
                  Use sample values
                </button>
                <button
                  className="btn btn-primary btn-lg"
                  disabled={!valid}
                  style={!valid ? { opacity: 0.5 } : undefined}
                  onClick={() =>
                    onConnect({
                      distributionId: d.distributionId.trim(),
                      tableName: d.tableName.trim(),
                      region: d.region,
                    })
                  }
                >
                  Connect <IconArrow size={18} />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
