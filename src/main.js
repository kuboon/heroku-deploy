import * as core from "@actions/core";
import { execSync as execSync_ } from "child_process";
import fs from "fs";
import path from "path";

// Support Functions
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const execSync = (cmd, opts = {}) => {
  console.log("Running command: " + cmd);
  return execSync_(cmd, opts) //, { stdio: ['pipe', 'pipe', process.stdout] })
};
const createNetrc = ({ email, api_key }) => `cat >~/.netrc <<EOF
machine api.heroku.com
    login ${email}
    password ${api_key}
machine git.heroku.com
    login ${email}
    password ${api_key}
EOF`;

const addRemote = ({ app_name, dontautocreate, buildpack, region, team, stack }) => {
  try {
    execSync("heroku git:remote --app " + app_name);
    console.log("Added git remote heroku");
  } catch (err) {
    if (dontautocreate) throw err;

    execSync(
      "heroku create " +
        app_name +
        (buildpack ? " --buildpack " + buildpack : "") +
        (region ? " --region " + region : "") +
        (stack ? " --stack " + stack : "") +
        (team ? " --team " + team : "")
    );
  }
};

const addConfig = ({ app_name, env_file, appdir }) => {
  let configVars = [];
  for (let key in process.env) {
    if (key.startsWith("HD_")) {
      configVars.push(key.substring(3) + "='" + process.env[key] + "'");
    }
  }
  if (env_file) {
    const env = fs.readFileSync(path.join(appdir, env_file), "utf8");
    const variables = require("dotenv").parse(env);
    const newVars = [];
    for (let key in variables) {
      newVars.push(key + "=" + variables[key]);
    }
    configVars = [...configVars, ...newVars];
  }
  if (configVars.length !== 0) {
    execSync(`heroku config:set --app=${app_name} ${configVars.join(" ")}`);
  }
};

const createProcfile = ({ procfile, appdir }) => {
  if (procfile) {
    fs.writeFileSync(path.join(appdir, "Procfile"), procfile);
    execSync(`git add -A && git commit -m "Added Procfile"`);
    console.log("Written Procfile with custom configuration");
  }
};

const deploy = ({
  dontuseforce,
  app_name,
  branch,
  appdir,
}) => {
  const force = !dontuseforce ? "--force" : "";
  {
    let remote_branch = execSync(
      "git remote show heroku | grep 'HEAD' | cut -d':' -f2 | sed -e 's/^ *//g' -e 's/ *$//g'"
    )
      .toString()
      .trim();

    if (remote_branch === "master") {
      execSync("heroku plugins:install heroku-repo");
      execSync("heroku repo:reset -a " + app_name);
    }

    if (appdir === "") {
      execSync(`git push heroku ${branch}:refs/heads/main ${force}`, {
        maxBuffer: 104857600,
      });
    } else {
      execSync(
        `git push ${force} heroku \`git subtree split --prefix=${appdir} ${branch}\`:refs/heads/main`,
        { maxBuffer: 104857600 }
      );
    }
  }
};
const deployDocker = ({
  dontuseforce,
  app_name,
  dockerHerokuProcessType,
  dockerBuildArgs,
  appdir,
}) => {
  const force = !dontuseforce ? "--force" : "";
  if (true) {
    execSync("heroku stack:set container");
    execSync(
      `heroku container:push ${dockerHerokuProcessType} --app ${app_name} ${dockerBuildArgs}`,
      appdir ? { cwd: appdir } : null
    );
    execSync(
      `heroku container:release ${dockerHerokuProcessType} --app ${app_name}`,
      appdir ? { cwd: appdir } : null
    );
  }
};

const healthcheckFailed = ({
  rollbackonhealthcheckfailed,
  app_name,
  appdir,
}) => {
  if (rollbackonhealthcheckfailed) {
    execSync(
      `heroku rollback --app ${app_name}`,
      appdir ? { cwd: appdir } : null
    );
    core.setFailed(
      "Health Check Failed. Error deploying Server. Deployment has been rolled back. Please check your logs on Heroku to try and diagnose the problem"
    );
  } else {
    core.setFailed(
      "Health Check Failed. Error deploying Server. Please check your logs on Heroku to try and diagnose the problem"
    );
  }
};

function installCli() {
  execSync("curl https://cli-assets.heroku.com/install.sh | sh")
}

// Input Variables
const heroku = {
  api_key: core.getInput("heroku_api_key"),
  email: core.getInput("heroku_email"),
  app_name: core.getInput("heroku_app_name"),
  buildpack: core.getInput("buildpack"),
  branch: core.getInput("branch"),
  dontuseforce: core.getInput("dontuseforce") === "false" ? false : true,
  dontautocreate: core.getInput("dontautocreate") === "false" ? false : true,
  usedocker: core.getInput("usedocker") === "false" ? false : true,
  dockerHerokuProcessType: core.getInput("docker_heroku_process_type"),
  dockerBuildArgs: core.getInput("docker_build_args"),
  appdir: core.getInput("appdir"),
  healthcheck: core.getInput("healthcheck"),
  checkstring: core.getInput("checkstring"),
  delay: parseInt(core.getInput("delay")),
  procfile: core.getInput("procfile"),
  rollbackonhealthcheckfailed:
    core.getInput("rollbackonhealthcheckfailed") === "false" ? false : true,
  env_file: core.getInput("env_file"),
  justlogin: core.getInput("justlogin") === "false" ? false : true,
  region: core.getInput("region"),
  stack: core.getInput("stack"),
  team: core.getInput("team"),
};

// Formatting
if (heroku.appdir) {
  heroku.appdir =
    heroku.appdir[0] === "." && heroku.appdir[1] === "/"
      ? heroku.appdir.slice(2)
      : heroku.appdir[0] === "/"
      ? heroku.appdir.slice(1)
      : heroku.appdir;
}

// Collate docker build args into arg list
if (heroku.dockerBuildArgs) {
  heroku.dockerBuildArgs = heroku.dockerBuildArgs
    .split("\n")
    .map((arg) => `${arg}="${process.env[arg]}"`)
    .join(",");
  heroku.dockerBuildArgs = heroku.dockerBuildArgs
    ? `--arg ${heroku.dockerBuildArgs}`
    : "";
}

(async () => {
  // Program logic
  try {
    // Just Login
    if (heroku.justlogin) {
      execSync(createNetrc(heroku));
      console.log("Created and wrote to ~/.netrc");

      return;
    }

    // Install Heroku CLI if not already installed
    try {
      execSync("heroku --version");
    } catch (err) {
      installCli();
    }

    execSync(createNetrc(heroku));
    console.log("Created and wrote to ~/.netrc");

    // Check login
    try {
      execSync("heroku auth:whoami");
    } catch {
      console.log("heroku auth failed. Check heroku_api_key is valid")
      exit(1)
    }

    execSync(`git config user.name "Heroku-Deploy"`);
    execSync(`git config user.email "${heroku.email}"`);
    const status = execSync("git status --porcelain").toString().trim();
    if (status) {
      console.log("Changes detected in the working directory.", status);
      execSync(
        'git add -A && git commit -m "Commited changes from previous actions"'
      );
    }

    // Check if using Docker
    if (!heroku.usedocker) {
      // Check if Repo clone is shallow
      const isShallow = execSync(
        "git rev-parse --is-shallow-repository"
      ).toString();

      // If the Repo clone is shallow, make it unshallow
      if (isShallow === "true\n") {
        execSync("git fetch --prune --unshallow");
      }
    }

    createProcfile(heroku);

    if (heroku.usedocker) {
      execSync("heroku container:login");
    }
    console.log("Successfully logged into heroku");

    addRemote(heroku);
    addConfig(heroku);

    if (heroku.usedocker) {
      deployDocker(heroku);
    } else {
      deploy(heroku);
    }

    const appDomain = JSON.parse(execSync("heroku domains -j").toString())[0].hostname;
    const healthcheckUrl = new URL(heroku.healthcheck, `https://${appDomain}`).href;
    if (true) {
      if (typeof heroku.delay === "number" && heroku.delay !== NaN) {
        await sleep(heroku.delay * 1000);
      }

      try {
        console.log(`Checking health of deployed app at ${healthcheckUrl}`);
        const res = await fetch(healthcheckUrl);
        if (res.status !== 200) {
          throw new Error(
            "Status code of network request is not 200: Status code - " +
              res.status
          );
        }
        const text = await res.text();
        if (heroku.checkstring && heroku.checkstring !== text) {
          throw new Error("Failed to match the checkstring");
        }
        console.log(text);
      } catch (err) {
        console.log(err.message);
        healthcheckFailed(heroku);
      }
    }

    core.setOutput("app_domain", appDomain);
    core.setOutput(
      "status",
      "Successfully deployed heroku app from branch " + heroku.branch
    );
  } catch (err) {
    if (
      heroku.dontautocreate &&
      err.toString().includes("Couldn't find that app")
    ) {
      core.setOutput(
        "status",
        "Skipped deploy to heroku app from branch " + heroku.branch
      );
    } else {
      core.setFailed(err.toString());
    }
  }
})();
