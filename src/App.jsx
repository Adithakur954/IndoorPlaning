import React from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import ProjectsPage from "./routes/ProjectsPage.jsx";
import PlannerPage from "./routes/PlannerPage.jsx";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        <Route
          path="/projects/:projectId"
          element={<Navigate to="design" replace />}
        />
        <Route path="/projects/:projectId/:section" element={<PlannerPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
