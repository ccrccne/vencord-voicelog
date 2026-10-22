/**
 * @name VoiceLog
 * @author cancercocaine
 * @authorId 1425095870399123662
 * @description Guarda quién entra y sale del canal de voz en el que estás (con hora), para ver a los que entran un segundo y se van. Pasa el ratón por la barrita debajo del canal.
 * @version 1.0.0
 * @source https://github.com/ccrccne/vencord-voicelog
 */

const MAX_ENTRIES = 300;
const QUICK_VISIT_MS = 15000;

const CSS = `
.vc-voicelog-side {
    margin: 2px 8px 4px 36px;
    padding: 3px 6px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--background-modifier-hover) 60%, transparent);
    opacity: 0.45;
    transition: opacity 0.15s;
    font-size: 11px;
    line-height: 16px;
    color: var(--channels-default, var(--text-muted));
}
.vc-voicelog-side:hover { opacity: 1; }
.vc-voicelog-side-summary { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vc-voicelog-side-list { max-height: 0; overflow: hidden; transition: max-height 0.2s ease; }
.vc-voicelog-side:hover .vc-voicelog-side-list { max-height: 220px; overflow-y: auto; margin-top: 3px; }
.vc-voicelog-side-row { display: flex; align-items: center; gap: 5px; padding: 1px 2px; border-radius: 4px; cursor: pointer; }
.vc-voicelog-side-row:hover { background: var(--background-modifier-hover); color: var(--interactive-hover); }
.vc-voicelog-quick { background: color-mix(in srgb, var(--status-warning) 12%, transparent); }
.vc-voicelog-side-avatar { width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0; }
.vc-voicelog-side-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vc-voicelog-side-time { flex-shrink: 0; font-variant-numeric: tabular-nums; }
.vc-voicelog-side-empty { font-style: italic; padding: 1px 2px; }
`;

const short = t => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

module.exports = class VoiceLog {
    constructor(meta) {
        this.api = new BdApi(meta.name);
        // Historial del canal de voz en el que estás. Solo vive en memoria.
        this.entries = [];
        this.inChannel = new Set();
        this.current = null;
        this.listeners = new Set();
        this.onSelect = this.onSelect.bind(this);
        this.onVoiceStates = this.onVoiceStates.bind(this);
    }

    start() {
        const { Webpack, DOM } = this.api;
        this.UserStore = Webpack.getStore("UserStore");
        this.ChannelStore = Webpack.getStore("ChannelStore");
        this.GuildMemberStore = Webpack.getStore("GuildMemberStore");
        this.SelectedChannelStore = Webpack.getStore("SelectedChannelStore");
        this.VoiceStateStore = Webpack.getStore("VoiceStateStore");
        this.profiles = Webpack.getByKeys("openUserProfileModal");
        this.dispatcher = Webpack.getByKeys("dispatch", "subscribe", "unsubscribe");

        DOM.addStyle(CSS);
        this.dispatcher.subscribe("VOICE_CHANNEL_SELECT", this.onSelect);
        this.dispatcher.subscribe("VOICE_STATE_UPDATES", this.onVoiceStates);
        this.setMyChannel(this.SelectedChannelStore.getVoiceChannelId() ?? null);

        this.patchVoiceList();
    }

    stop() {
        this.abort?.abort();
        this.api.Patcher.unpatchAll();
        this.api.DOM.removeStyle();
        this.dispatcher?.unsubscribe("VOICE_CHANNEL_SELECT", this.onSelect);
        this.dispatcher?.unsubscribe("VOICE_STATE_UPDATES", this.onVoiceStates);
        this.entries = [];
        this.inChannel.clear();
        this.current = null;
    }

    // La lista de personas debajo de un canal de voz se carga más tarde, así que la esperamos.
    async patchVoiceList() {
        const { Webpack, Patcher } = this.api;
        this.abort = new AbortController();
        const mod = await Webpack.waitForModule(
            Webpack.Filters.bySource("voice-invite-suggestions-button", "collapsed-users"),
            { signal: this.abort.signal, defaultExport: false }
        );
        if (!mod) return;

        const key = Object.keys(mod).find(k =>
            typeof mod[k] === "function" && mod[k].toString().includes("collapsed-users")
        );
        if (!key) return console.error("[VoiceLog] No se encontró la lista del canal de voz.");

        // Añade la barrita justo después de la fila "Invitar a llamada".
        Patcher.after(mod, key, (_, [props], ret) => {
            const children = ret?.props?.children;
            const users = Array.isArray(children) ? children[0] : null;
            if (!Array.isArray(users) || !props?.channel) return;
            users.push(BdApi.React.createElement(this.SidebarLog, { key: "vc-voicelog-side", channel: props.channel }));
        });
    }

    emit() {
        this.listeners.forEach(f => f());
    }

    userInfo(userId, channelId) {
        const user = this.UserStore.getUser(userId);
        const guildId = this.ChannelStore.getChannel(channelId)?.guild_id;
        const nick = guildId ? this.GuildMemberStore.getNick(guildId, userId) : null;
        return {
            name: nick ?? user?.globalName ?? user?.username ?? userId,
            avatar: user?.getAvatarURL(guildId, 64) ?? "https://cdn.discordapp.com/embed/avatars/0.png"
        };
    }

    // Se llama cuando entras, sales o cambias de canal de voz. Al cambiar, el historial empieza de cero.
    setMyChannel(channelId) {
        if (channelId === this.current) return;

        this.entries = [];
        this.inChannel.clear();
        this.current = channelId;

        if (channelId) {
            const myId = this.UserStore.getCurrentUser()?.id;
            for (const userId of Object.keys(this.VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {})) {
                if (userId !== myId) this.inChannel.add(userId);
            }
        }

        this.emit();
    }

    onSelect({ channelId }) {
        this.setMyChannel(channelId ?? null);
    }

    onVoiceStates({ voiceStates }) {
        if (!this.current) return;
        const myId = this.UserStore.getCurrentUser()?.id;
        let changed = false;

        for (const s of voiceStates) {
            if (s.userId === myId) continue;

            const was = this.inChannel.has(s.userId);
            const is = s.channelId === this.current;
            if (is && !was) {
                this.inChannel.add(s.userId);
                this.entries.push({ id: s.userId, ...this.userInfo(s.userId, this.current), join: Date.now(), leave: null });
                if (this.entries.length > MAX_ENTRIES) this.entries.shift();
                changed = true;
            } else if (!is && was) {
                this.inChannel.delete(s.userId);
                const open = this.entries.findLast(e => e.id === s.userId && e.leave === null);
                if (open) open.leave = Date.now();
                changed = true;
            }
        }

        if (changed) this.emit();
    }

    openProfile(userId, channel) {
        this.profiles?.openUserProfileModal({ userId, guildId: channel.guild_id, channelId: channel.id });
    }

    // Barrita debajo de la lista de personas del canal de voz.
    // Plegada muestra solo un resumen; al pasar el ratón se despliega con quién entró y salió.
    SidebarLog = ({ channel }) => {
        const { React } = BdApi;
        const [, force] = React.useReducer(x => x + 1, 0);
        React.useEffect(() => {
            this.listeners.add(force);
            this.SelectedChannelStore.addChangeListener(force);
            return () => {
                this.listeners.delete(force);
                this.SelectedChannelStore.removeChangeListener(force);
            };
        }, []);

        if (channel.id !== this.SelectedChannelStore.getVoiceChannelId()) return null;

        const h = React.createElement;
        const list = this.entries;
        const left = list.filter(e => e.leave !== null).length;

        const rows = list.slice().reverse().map((e, i) => {
            const quick = e.leave !== null && e.leave - e.join < QUICK_VISIT_MS;
            return h("div", {
                key: list.length - i,
                className: "vc-voicelog-side-row" + (quick ? " vc-voicelog-quick" : ""),
                onClick: () => this.openProfile(e.id, channel)
            },
            h("img", { className: "vc-voicelog-side-avatar", src: e.avatar, alt: "" }),
            h("span", { className: "vc-voicelog-side-name" }, e.name),
            h("span", { className: "vc-voicelog-side-time" }, `${short(e.join)} → ${e.leave === null ? "ahora" : short(e.leave)}`)
            );
        });

        return h("div", { className: "vc-voicelog-side", onClick: e => e.stopPropagation() },
            h("div", { className: "vc-voicelog-side-summary" }, `Historial · ${list.length - left} entraron · ${left} salieron`),
            h("div", { className: "vc-voicelog-side-list" },
                list.length === 0 && h("div", { className: "vc-voicelog-side-empty" }, "Nadie ha entrado aún"),
                rows
            )
        );
    };
};
