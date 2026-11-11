import { auth, defineMcp } from "@lovable.dev/mcp-js";
import getMyAccess from "./tools/get-my-access";
import getSafetySettings from "./tools/get-safety-settings";
import listProjects from "./tools/list-projects";
import listRecentActivity from "./tools/list-recent-activity";
import listOmniJobs from "./tools/list-omni-jobs";
import listTasks from "./tools/list-tasks";
import listApprovalRequests from "./tools/list-approval-requests";

// Vite inlines the stable ref; the published SUPABASE_URL may be a proxy.
const projectRef = import.meta.env["VITE_SUPABASE_PROJECT_ID"] ?? "project-ref-unset";

export default defineMcp({
  name: "jackboy-dev-control",
  title: "Jackboy Dev Control",
  version: "0.1.0",
  instructions:
    "Read-only tools for Jackboy: your access, safety settings, projects, activity, OMNI jobs, tasks and approval requests. Results follow your Jackboy role; nothing here can approve, dispatch, change settings or turn on automation.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [getMyAccess, getSafetySettings, listProjects, listRecentActivity, listOmniJobs, listTasks, listApprovalRequests],
});
