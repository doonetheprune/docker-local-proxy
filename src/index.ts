#!/usr/bin/env node
// src/index.ts

import Docker from 'dockerode';
import Handlebars from 'handlebars';
import {writeFile, readFile, mkdir} from 'fs/promises';
import {existsSync} from 'fs';
import {EOL} from 'os';
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import {exec} from "node:child_process";
import * as path from "node:path";

const argv = yargs(hideBin(process.argv))
    .option('httpPort', {
        alias: 'p',
        description: 'The HTTP ports to use in Nginx configurations, comma-separated',
        type: 'string',
        coerce: (arg) => {
            if (typeof arg === 'string') {
                return arg.split(',').map((port: string) => parseInt(port, 10)).filter((port: number) => !isNaN(port));
            }
            return arg;
        },
        default: [80]
    })
    .option('tcpPort', {
        alias: 'q',
        description: 'The TCP ports to use in Nginx configurations, comma-separated',
        type: 'string',
        coerce: (arg) => {
            if (typeof arg === 'string') {
                return arg.split(',').map((port: string) => parseInt(port, 10)).filter((port: number) => !isNaN(port));
            }
            return arg;
        },
        default: [5432]
    })
    .option('filterName', {
        alias: 'f',
        description: 'Container name filter to apply',
        type: 'string',
        default: 'internal-proxy'
    })
    .option('networkOnly', {
        alias: 'n',
        description: 'Only create the Docker network',
        type: 'boolean',
        default: false
    })
    .option('hostsOnly', {
        alias: 'o',
        description: 'Only update the hosts file',
        type: 'boolean',
        default: false
    })
    .help()
    .alias('help', 'h')
    .argv;

console.log(`Using HTTP Ports: ${argv.httpPort.join(', ')}`);
console.log(`Using TCP Ports: ${argv.tcpPort.join(', ')}`);
console.log(`Using Filter Name: ${argv.filterName}`);

const docker = new Docker({socketPath: '/var/run/docker.sock'})
const PROJECT_ROOT =  path.resolve(__dirname + '/../');
const GENERATED_DIR = PROJECT_ROOT + '/generated';
const NETWORK_NAME = 'docker-local-proxy';
const HOSTS_PATH = '/etc/hosts';
const START_MARKER = '### START GENERATED BY docker-local-proxy ###';
const END_MARKER = '### END docker-local-proxy ###';


async function ensureDirectory() {
    if (!existsSync(GENERATED_DIR)) {
        await mkdir(GENERATED_DIR, {recursive: true});
    }
}

interface ContainerInfo {
    id: string,
    name: string;
    fullName: string;
    hostname: string;
}

async function fetchRunningContainers(): Promise<ContainerInfo[]> {
    const containers = await docker.listContainers();
    const filteredContainers = containers
        .filter(container => container.Names.some(name => name.includes(argv.filterName)));

    const containerInfos = filteredContainers.map(container => {
        // Default hostname construction from container name
        const defaultName = container.Names[0].replace(/^\//, '').split('-')[0];
        const defaultHostname = `${defaultName}.localhost`;

        // Check if there is a 'hostname' label and use the value after '=' if present
        let hostname = defaultHostname; // Default to constructed hostname
        if (container.Labels && container.Labels['hostname']) {
            hostname = container.Labels['hostname']
        }

        return {
            id: container.Id,
            name: defaultName,
            fullName: container.Names[0].slice(1),
            hostname: hostname
        };
    });

    return containerInfos;
}

// Check if containers are connected to the specified network
async function checkContainersOnNetwork(containers: ContainerInfo[], networkName: string) {
    const network = docker.getNetwork(networkName);
    const networkInfo = await network.inspect();

    containers.forEach(container => {
        const isConnected = Object.keys(networkInfo.Containers).includes(container.id);
        if (!isConnected) {
            throw new Error(`Container ${container.name} is not connected to the network ${networkName}`);
        }
    });

    console.log(`All containers are connected to the network ${networkName}`);
}

function generateNginxConfigs(containers: ContainerInfo[]): { httpConfig: string, tcpConfig: string } {
    const httpTemplate = `    
{{#each containers}}
  {{#each ../httpPort}}
  
# Default server block to catch all other requests
server {
    listen {{this}};
    server_name _;  # Wildcard server name to catch all requests

    # Return a 404 Forbidden error for any unmatched server_name
    location / {
        return 404 '{"status": 404, "message": "No cluster found for subdomain provided"}';
        add_header Content-Type application/json;
    }
}
  
server {
    listen {{this}};
    server_name {{../this.hostname}};
    
    error_page 502 503 504 @custom_error;
    proxy_intercept_errors on;
    
    set $original_uri $request_uri;

    # Custom error handling location
    location @custom_error {
        internal;
        # You can use more variables here to make the error message more informative
        return 200 '{"status": "$status", "message": "Error occurred", "inbound_url": "$original_uri", "attempted_url": "$attempted_url", "proxy": "host-wide-local-proxy"}';
        add_header Content-Type application/json;
    }
    
    location / {
        set $attempted_url http://{{../this.fullName}}:{{this}};
        proxy_pass $attempted_url;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
  {{/each}}
{{/each}}
    `;

    const tcpTemplate = `
{{#each containers}}
  {{#each ../tcpPort}}
server {
    listen {{add this @../index}};
    proxy_pass {{../this.fullName}}:{{this}};
}
  {{/each}}
{{/each}}
    `;

    const httpCompiledTemplate = Handlebars.compile(httpTemplate);
    const tcpCompiledTemplate = Handlebars.compile(tcpTemplate);

    Handlebars.registerHelper('add', function (a, b) {
        return a + b;
    });

    return {
        httpConfig: httpCompiledTemplate({containers, httpPort: argv.httpPort}),
        tcpConfig: tcpCompiledTemplate({containers, tcpPort: argv.tcpPort})
    };
}

async function updateHostsFile(containers: ContainerInfo[]) {
    let contents = await readFile(HOSTS_PATH, 'utf8');
    const entries = containers.map(container => `127.0.0.1 ${container.hostname}`).join(EOL);

    const startIdx = contents.indexOf(START_MARKER) + START_MARKER.length;
    const endIdx = contents.indexOf(END_MARKER);
    if (startIdx !== -1 && endIdx !== -1) {
        contents = contents.slice(0, startIdx) + EOL + entries + EOL + contents.slice(endIdx);
    } else {
        contents += EOL + START_MARKER + EOL + entries + EOL + END_MARKER + EOL;
    }

    await writeFile(HOSTS_PATH, contents, 'utf8');
}

// Create Docker network if it doesn't exist
async function createDockerNetwork() {
    const networkName = 'docker-local-proxy';
    const networks = await docker.listNetworks();
    const networkExists = networks.some(network => network.Name === networkName);

    if (!networkExists) {
        // Network does not exist, so create it
        try {
            const network = await docker.createNetwork({ Name: networkName });
            console.log('Network created:', network.id);
        } catch (error) {
            console.error('Failed to create network:', error);
        }
    } else {
        console.log('Network already exists.');
    }
}

function updateDockerCompose(containers: ContainerInfo[],httpPorts: number[], tcpPorts: number[]) {
    const composePath = PROJECT_ROOT + '/docker-compose.yml';

    try {
        const doc = yaml.load(fs.readFileSync(composePath, 'utf8')) as any;

        if (doc.services && doc.services['nginx-proxy']) {
            const existingPorts = doc.services['nginx-proxy'].ports || [];

            // Generate new port mappings for HTTP and TCP
            const newHttpPorts = httpPorts.map(port => `${port}:${port}`);
            const newTcpPorts = containers.flatMap((_, index) =>
                tcpPorts.map(port => `${port + index}:${port + index}`)
            );
            // Combine existing with new ports
            doc.services['nginx-proxy'].ports = [ ...newHttpPorts, ...newTcpPorts];
        }

        // Write back the updated configuration
        const newYamlStr = yaml.dump(doc, {lineWidth: -1});
        fs.writeFileSync(composePath, newYamlStr, 'utf8');
        console.log('Updated Docker Compose file with new HTTP ports:', httpPorts.join(', '));
        console.log('Updated Docker Compose file with new TCP ports:', tcpPorts.join(', '));
    } catch (e) {
        console.error('Failed to update Docker Compose file:', e);
    }
}

function runDockerComposeUp() {
    return new Promise((resolve, reject) => {
        const options = {
            cwd: PROJECT_ROOT
        };

        exec('docker compose -p docker-local-proxy up -d', options, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error running docker-compose up: ${error.message}`);
                return;
            }
            if (stderr) {
                console.error(`stderr: ${stderr}`);
                resolve(stdout)
            }
            console.log(`stdout: ${stdout}`);
            resolve(stdout)
        });
    })
}

async function main() {
    const containers = await fetchRunningContainers();

    if (argv.networkOnly) {
        console.log('Only Creating The Network')
        await createDockerNetwork();
        return;
    }else if (argv.hostsOnly) {
        console.log('Only Updating the Hosts File');
        if (process.getuid && process.getuid() === 0) {
            await updateHostsFile(containers);
            console.log('Successfully updated /etc/hosts.');
        } else {
            console.error('Administrative privileges required to update /etc/hosts.');
        }
        return;
    }

    await ensureDirectory();  // Ensure the generated directory exists
    await createDockerNetwork()

    await checkContainersOnNetwork(containers, NETWORK_NAME);  // Check if containers are on the network
    const {httpConfig, tcpConfig} = generateNginxConfigs(containers);

    await writeFile(`${GENERATED_DIR}/http_proxies.conf`, httpConfig, 'utf8');
    await writeFile(`${GENERATED_DIR}/tcp_proxies.conf`, tcpConfig, 'utf8');

    if (process.getuid && process.getuid() === 0) {
        await updateHostsFile(containers);
        console.log('Successfully updated /etc/hosts.');
    } else {
        console.error('Administrative privileges required to update /etc/hosts.');
    }

    updateDockerCompose(containers, argv.httpPort, argv.tcpPort);
    await runDockerComposeUp();

    containers.forEach((container, index) => {
        const httpBindings = argv.httpPort.join(', ');
        const tcpBindings = argv.tcpPort.map(port => `${port + index}:${port}`).join(', ');
        console.log(`   - Container: ${container.fullName}, Hostname: ${container.hostname}, HTTP: ${httpBindings}, TCP: ${tcpBindings}`);
    });
}

main();