import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { initialPlan } from "../models/plan.js";
import {
  createProject,
  deleteProject,
  listProjects,
} from "../services/projects.js";

export default function ProjectsPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState([]);
  const [message, setMessage] = useState("");

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

  const create = async () => {
    const name = window.prompt("Project name", "New indoor plan");
    if (!name?.trim()) return;
    try {
      const project = await createProject(name.trim(), initialPlan());
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

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">⌗</span>
          <div>
            <strong>Indoor Planner</strong>
            <small>Spatial design and RF analysis</small>
          </div>
        </div>
        <button className="primary" onClick={create}>
          + New project
        </button>
      </header>
      <main className="landing">
        <div className="hero">
          <div className="eyebrow">PROJECT WORKSPACE</div>
          <h1>
            Plan every floor.
            <br />
            See every signal.
          </h1>
          <p>
            Build indoor geometry, place network equipment, compare predicted
            coverage with measured logs, and save the entire plan in one
            project.
          </p>
          <button className="primary" onClick={create}>
            Create indoor project →
          </button>
        </div>
        <section className="project-section">
          <div className="section-title">
            <h2>Your projects</h2>
            <span>{projects.length} saved</span>
          </div>
          {message && (
            <div className="notice" role="status">
              {message}
            </div>
          )}
          {projects.length ? (
            <div className="project-grid">
              {projects.map((project) => (
                <article key={project.id} className="project-card">
                  <div className="card-icon">▦</div>
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
              No projects yet. Create one to start your floor plan.
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
