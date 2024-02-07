# JET Pilot

<p align="center">
<img src="https://raw.githubusercontent.com/unxsist/jet-pilot/main/public/header.png"/>
</p>

## Introduction
JET Pilot is an open-source K8s IDE. It was created out of frustration, as all "good-looking" K8s IDEs went commercial. Power-users nowaday resort to tools like `k9s`, which works great, but heavily relies on keyboard input. JET Pilot tries to overcome these usability challenges.

## Features
- **Real-time Logs**: Instantly access logs for active monitoring of Kubernetes workloads.
- **Kubernetes Object Management**: Easily manage Kubernetes objects, describe objects or edit them directly.
- **Container Shell**: Quickly instantiate a shell on your containers
- **Command Palette**: A user-friendly interface with customizable shortcuts for efficient navigation and operation.

## Installation Instructions

### macOS

1. Download the [latest release for MacOS](https://github.com/unxsist/jet-pilot/releases/latest/) from here.
2. Double-click the downloaded `.dmg` file to mount it.
3. Drag the application icon to the Applications folder.
4. Eject the mounted disk image.
5. You can now find and launch the application in your Applications folder.

### Linux (`.deb` package or `.AppImage`)

For Debian-based distributions (e.g., Ubuntu):
1. Download the [latest .deb release](https://github.com/unxsist/jet-pilot/releases/latest/) from here.
2. Open your terminal and navigate to the directory where the package is downloaded.
3. Run the following command to install the package:
   ```bash
   sudo dpkg -i jet-pilot_version_amd64.deb
   ```
4. Alternatively, if you prefer the AppImage format:
   1. Download the [latest .AppImage release](https://github.com/unxsist/jet-pilot/releases/latest/) from here.
   - Make it executable by running:
     ```bash
     chmod +x jet-pilot_version_amd64.AppImage
     ```
   - You can now run the application by double-clicking the `.AppImage` file or executing it from the terminal.

### Windows (`.exe` installer or `.msi` installer)

1. Download the [latest .msi or installer for Windows](https://github.com/unxsist/jet-pilot/releases/latest/) from here.
2. Double-click the downloaded installer file.
3. Follow the on-screen instructions to complete the installation process.