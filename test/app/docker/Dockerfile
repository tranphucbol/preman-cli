# The Linux box the app suites run in: Electron's shared libraries, a virtual display, a window
# manager, fonts with macOS-like metrics, and ffmpeg for the README GIFs. See docs/plans/032.
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    TZ=UTC

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb xauth openbox x11-utils \
      libgtk-3-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libdbus-1-3 \
      libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxss1 libxtst6 \
      libxkbcommon0 libgbm1 libdrm2 libasound2 libcups2 libnotify4 \
      locales fonts-dejavu-core fonts-liberation fonts-noto-color-emoji fonts-jetbrains-mono \
      ffmpeg ca-certificates unzip \
 && sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen \
 && locale-gen \
 && rm -rf /var/lib/apt/lists/*

COPY fonts.conf /etc/fonts/local.conf
RUN fc-cache -f

# Declared late so a bun bump rebuilds one layer, not the apt one. `run.ts` passes .bun-version.
ARG BUN_VERSION=1.3.4
RUN npm install -g "bun@${BUN_VERSION}"

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /work
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
