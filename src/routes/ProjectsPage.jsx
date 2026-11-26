import companySvg from "../assets/company-logo.svg?raw";
import LicenseBadge from "../components/LicenseBadge.jsx";
import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { initialPlan } from "../models/plan.js";
import {
  createProject,
  deleteProject,
  listProjects,
} from "../services/projects.js";
import { WORKSPACES, useWorkspace, workspaceOf } from "../workspace.js";

// Crop the logo's empty margins (same crop as the report header).
const companyLogo = `data:image/svg+xml;utf8,${encodeURIComponent(
  companySvg.replace(/viewBox="[^"]*"/, 'viewBox="70 110 620 300"'),
)}`;

function Brand() {
  return (
    <div className="brand">
      <img className="brand-logo" src={companyLogo} alt="Company logo" />
      <div>
        <strong>Indoor Planner</strong>
        <small>Spatial design and RF analysis</small>
      </div>
    </div>
  );
}

// Shown on start when the license has both modules and none is chosen yet.
function WorkspaceChooser({ onChoose }) {
  return (
    <main className="landing workspace-choice">
      <div className="eyebrow">CHOOSE A WORKSPACE</div>
      <h1>What are you planning today?</h1>
      <div className="workspace-options">
        {Object.values(WORKSPACES).map((w) => (
          <button key={w.id} type="button" className={`workspace-option ${w.id}`} onClick={() => onChoose(w.id)}>
            <span className={`project-kind ${w.id}`}>{w.label}</span>
            <strong>{w.label} planning</strong>
            <small>{w.hint}</small>
          </button>
        ))}
      </div>
      <p className="hint">You can switch workspace at any time from the top bar.</p>
    </main>
  );
}

function WorkspaceSwitch({ licensed, workspace, onChoose }) {
  if (licensed.length < 2)
    return <span className={`project-kind ${workspace}`}>{WORKSPACES[workspace].label}</span>;
  return (
    <div className="workspace-switch" role="group" aria-label="Workspace">
      {licensed.map((id) => (
        <button key={id} type="button" className={id === workspace ? "active" : ""} aria-pressed={id === workspace} onClick={() => onChoose(id)}>
          {WORKSPACES[id].label}
        </button>
      ))}
    </div>
  );
}

function NewProjectDialog({ workspace, onCancel, onCreate }) {
  const [name, setName] = useState("New indoor plan");
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  const submit = (e) => {
    e.preventDefault();
    if (name.trim()) onCreate(name.trim());
  };
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="new-project-title" onSubmit={submit}>
        <h2 id="new-project-title">
          New {WORKSPACES[workspace].label} project
        </h2>
        <label className="dialog-field">
          Project name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} />
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary" disabled={!name.trim()}>Create project</button>
        </div>
      </form>
    </div>
  );
}

export default function ProjectsPage() {
  const navigate = useNavigate();
  const { ready, licensed, workspace, choose } = useWorkspace();
  const [projects, setProjects] = useState([]);
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);

  const refresh = async () => {
    try {
      setProjects(await listProjects());
    } catch (error) {
      setMessage(error.message);
    }
  };
  useEffect(() => {
    refresh();
  }, []);

  const create = () => setCreating(true);
  const finishCreate = async (name) => {
    setCreating(false);
    try {
      const project = await createProject(name, { ...initialPlan(), projectType: workspace });
      navigate(`/projects/${project.id}/design`);
    } catch (error) {
      setMessage(error.message);
    }
  };

  const remove = async (project) => {
    if (!window.confirm(`Delete “${project.name}”?`)) return;
    try {
      await deleteProject(project.id);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  };

  if (!ready)
    return (
      <div className="shell">
        <header className="topbar">
          <Brand />
        </header>
      </div>
    );

  if (!workspace)
    return (
      <div className="shell">
        <header className="topbar">
          <Brand />
          <div style={{ marginLeft: "auto" }}>
            <LicenseBadge />
          </div>
        </header>
        <WorkspaceChooser onChoose={choose} />
      </div>
    );

  const label = WORKSPACES[workspace].label;
  const shown = projects.filter((p) => workspaceOf(p) === workspace);
  return (
    <div className="shell">
      <header className="topbar">
        <Brand />
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginLeft: "auto" }}>
          <WorkspaceSwitch licensed={licensed} workspace={workspace} onChoose={choose} />
          <LicenseBadge />
          <button className="primary" onClick={create}>
            + New project
          </button>
        </div>
      </header>
      <main className="landing">
        <div className="hero">
          <div className="eyebrow">{label.toUpperCase()} WORKSPACE</div>
          <h1>
            Plan every floor.
            <br />
            See every signal.
          </h1>
          <p>
            {workspace === "cellular"
              ? "Build indoor geometry, place IBS / DAS antennas, set up carriers and predict RSRP and SINR for every floor."
              : "Build indoor geometry, place access points, compare predicted coverage with measured logs, and save the entire plan in one project."}
          </p>
          <button className="primary" onClick={create}>
            Create {label} project →
          </button>
        </div>
        <section className="project-section">
          <div className="section-title">
            <h2>Your {label} projects</h2>
            <span>{shown.length} saved</span>
          </div>
          {message && (
            <div className="notice" role="status">
              {message}
            </div>
          )}
          {shown.length ? (
            <div className="project-grid">
              {shown.map((project) => (
                <article key={project.id} className="project-card">
                  <div className="card-head">
                    <div className="card-icon">▦</div>
                    <span className={`project-kind ${workspace}`}>{label}</span>
                  </div>
                  <h3>{project.name}</h3>
                  <p>
                    {project.floorCount} floors · {project.roomCount} rooms
                  </p>
                  <small>
                    Updated {new Date(project.updatedAt).toLocaleString()}
                  </small>
                  <div className="card-actions">
                    <button
                      className="primary"
                      onClick={() => navigate(`/projects/${project.id}/design`)}
                    >
                      Open project
                    </button>
                    <button
                      className="danger-text"
                      onClick={() => remove(project)}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty">
              No {label} projects yet. Create one to start your floor plan.
            </div>
          )}
        </section>
      </main>
      {creating && (
        <NewProjectDialog workspace={workspace} onCancel={() => setCreating(false)} onCreate={finishCreate} />
      )}
    </div>
  );
}
