
# docker-local-proxy

`docker-local-proxy` is a tool for automatically configuring Nginx and updating `/etc/hosts` based on Docker containers for local development environments. It simplifies the process of setting up local proxies, allowing for dynamic HTTP and TCP port configurations.

## Features

- Automatically fetches running Docker containers based on a specified filter.
- Generates Nginx configuration files for HTTP and TCP proxies.
- Updates the `/etc/hosts` file with container hostnames.
- Configurable HTTP and TCP ports via command-line arguments.
- Outputs generated files to a specified directory.
- Ensures containers are on the specified Docker network.

## Installation

To install `docker-local-proxy`, you need to have Node.js and npm installed. Then, you can install the package via npm:

```bash
npm install --save-dev docker-local-proxy
```

## Usage

After installing the package, you can use it via the command line:

```bash
docker-local-proxy --httpPort 80 --tcpPort 5432 --filterName "internal-proxy"
```

### Command-Line Options

- `--httpPort, -p`: The HTTP ports to use in Nginx configurations, comma-separated. Default is `80`.
- `--tcpPort, -q`: The TCP ports to use in Nginx configurations, comma-separated. Default is `5432`.
- `--filterName, -f`: Container name filter to apply. Default is `internal-proxy`.
- `--networkOnly, -n`: Only creates the `docker-local-proxy` that both the nginx proxy and your containers needs to be on. Use this if your container is complaining the network test exist.
- `--help, -h`: Show help.

### Examples

#### Basic Usage

Using default ports and filter name:

```bash
docker-local-proxy
```

#### Custom Ports and Filter Name

```bash
docker-local-proxy --httpPort 8080,8081 --tcpPort 5433,5434 --filterName "my-proxy"
```

## Docker container Configuration

Ensure that your Docker containers are on the `docker-local-proxy` network. Here is an example Docker Compose configuration:

```yaml
services:
  internal-proxy:
    image: traefik:v2.5
    labels:
      - "hostname=my-custom-subdomain.localhost"
    command:
      - "--api.insecure=true"
      - "--providers.docker=true"
      - "--providers.docker.network=cp-net"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.tcp.address=:5432"
    volumes:
      - "/var/run/docker.sock:/var/run/docker.sock"
    networks:
      your-internal-net:
      docker-local-proxy:
networks:
  docker-local-proxy:
    external: true
  your-internal-net:
    driver: bridge
    ipam:
      config:
        - subnet: 172.25.0.0/16
```

### Adding a Hostname Label
To add a hostname label, specify it in the labels section of your service in the Docker Compose file. The label should follow the format hostname=custom-hostname, where custom-hostname is the desired hostname. This label allows network services, like proxies or load balancers, to recognize the container by the specified hostname instead of just taking the first word up to the dash in the container name.

## Generated Files

The tool outputs the following files to the `./generated` directory:

- `http_proxies.conf`: Nginx configuration for HTTP proxies.
- `tcp_proxies.conf`: Nginx configuration for TCP proxies.

Ensure the `./generated` directory exists or will be created by the tool.

## Updating /etc/hosts

The tool updates the `/etc/hosts` file to include entries for the filtered Docker containers. Note that administrative privileges are required to modify `/etc/hosts`. Run the tool with `sudo` if necessary:

```bash
sudo docker-local-proxy --httpPort 8080,8081 --tcpPort 5433,5434 --filterName "my-proxy"
```

## Development

### Prerequisites

- Node.js
- npm
- Docker

### Setup

Clone the repository and install dependencies:

```bash
git clone https://github.com/yourusername/docker-local-proxy.git
cd docker-local-proxy
npm install
```

### Building the Project

Compile the TypeScript code to JavaScript:

```bash
npm run build
```

### Running the Script

To run the script with `ts-node`:

```bash
npx ts-node src/index.ts --httpPort 8080,8081 --tcpPort 5433,5434 --filterName "my-proxy"
```

## Contributing

Contributions are welcome! Please open an issue or submit a pull request on GitHub.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgements

Special thanks to the open-source community for providing the tools and libraries that made this project possible.
