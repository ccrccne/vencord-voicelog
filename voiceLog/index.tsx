import "./styles.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { openUserProfile } from "@utils/discord";
import definePlugin from "@utils/types";
import { ChannelStore, GuildMemberStore, SelectedChannelStore, useEffect, useReducer, UserStore, useStateFromStores, VoiceStateStore } from "@webpack/common";

const MAX_ENTRIES = 300;
const QUICK_VISIT_MS = 15_000;

interface Entry {
    id: string;
    name: string;
    avatar: string;
    join: number;
    leave: number | null; // null = sigue en el canal
}

// Historial del canal de voz en el que estás. Solo vive en memoria.
let entries: Entry[] = [];
const inChannel = new Set<string>();
let current: string | null = null;

const listeners = new Set<() => void>();
const emit = () => listeners.forEach(f => f());

function userInfo(userId: string, channelId: string) {
    const user = UserStore.getUser(userId);
    const guildId = ChannelStore.getChannel(channelId)?.guild_id;
    const nick = guildId ? GuildMemberStore.getNick(guildId, userId) : null;
    return {
        name: nick ?? (user as any)?.globalName ?? user?.username ?? userId,
        avatar: user?.getAvatarURL(guildId, 64) ?? "https://cdn.discordapp.com/embed/avatars/0.png"
    };
}

// Se llama cuando entras, sales o cambias de canal de voz. Al cambiar, el historial empieza de cero.
function setMyChannel(channelId: string | null) {
    if (channelId === current) return;

    entries = [];
    inChannel.clear();
    current = channelId;

    if (channelId) {
        const myId = UserStore.getCurrentUser()?.id;
        for (const userId of Object.keys(VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {})) {
            if (userId !== myId) inChannel.add(userId);
        }
    }

    emit();
}

function useEntries() {
    const [, force] = useReducer((x: number) => x + 1, 0);
    useEffect(() => {
        listeners.add(force);
        return () => void listeners.delete(force);
    }, []);
    return entries;
}

const short = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// Barrita debajo de la lista de personas del canal de voz (barra lateral).
// Plegada muestra solo un resumen; al pasar el ratón se despliega con quién entró y salió.
const SidebarLog = ErrorBoundary.wrap(({ channel }: { channel: { id: string; }; }) => {
    const voiceId = useStateFromStores([SelectedChannelStore], () => SelectedChannelStore.getVoiceChannelId());
    const list = useEntries();
    if (!channel || channel.id !== voiceId) return null;

    const left = list.filter(e => e.leave !== null).length;

    return (
        <div className="vc-voicelog-side" onClick={e => e.stopPropagation()}>
            <div className="vc-voicelog-side-summary">
                Historial · {list.length - left} entraron · {left} salieron
            </div>
            <div className="vc-voicelog-side-list">
                {list.length === 0 && <div className="vc-voicelog-side-empty">Nadie ha entrado aún</div>}
                {list.slice().reverse().map((e, i) => {
                    const quick = e.leave !== null && e.leave - e.join < QUICK_VISIT_MS;
                    return (
                        <div
                            key={list.length - i}
                            className={"vc-voicelog-side-row" + (quick ? " vc-voicelog-quick" : "")}
                            onClick={() => openUserProfile(e.id).catch(() => { })}
                        >
                            <img className="vc-voicelog-side-avatar" src={e.avatar} alt="" />
                            <span className="vc-voicelog-side-name">{e.name}</span>
                            <span className="vc-voicelog-side-time">
                                {short(e.join)} → {e.leave === null ? "ahora" : short(e.leave)}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}, { noop: true });

export default definePlugin({
    name: "VoiceLog",
    description: "Guarda quién entra y sale del canal de voz en el que estás (con hora), para ver a los que entran un segundo y se van.",
    authors: [{ name: "cancercocaine", id: 1425095870399123662n }],

    patches: [
        {
            find: '"voice-invite-suggestions-button"',
            replacement: {
                // Justo después de la fila "Invitar a llamada" en la lista de personas del canal.
                match: /(\i)&&(\i)\.push\(\(0,\i\.jsx\)\(\i\.\i,\{channel:(\i),onClose:\i\},"voice-invite-suggestions-button"\)\)/,
                replace: '$&,$2.push($self.renderSidebarLog({channel:$3},"vc-voicelog-side"))'
            }
        }
    ],

    renderSidebarLog: (props: { channel: { id: string; }; }, key: string) => <SidebarLog key={key} {...props} />,

    flux: {
        VOICE_CHANNEL_SELECT({ channelId }: { channelId: string | null; }) {
            setMyChannel(channelId ?? null);
        },

        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: { userId: string; channelId?: string | null; }[]; }) {
            if (!current) return;
            const myId = UserStore.getCurrentUser()?.id;
            let changed = false;

            for (const s of voiceStates) {
                if (s.userId === myId) continue;

                const was = inChannel.has(s.userId);
                const is = s.channelId === current;
                if (is && !was) {
                    inChannel.add(s.userId);
                    entries.push({ id: s.userId, ...userInfo(s.userId, current), join: Date.now(), leave: null });
                    if (entries.length > MAX_ENTRIES) entries.shift();
                    changed = true;
                } else if (!is && was) {
                    inChannel.delete(s.userId);
                    const open = entries.findLast(e => e.id === s.userId && e.leave === null);
                    if (open) open.leave = Date.now();
                    changed = true;
                }
            }

            if (changed) emit();
        }
    },

    start() {
        setMyChannel(SelectedChannelStore.getVoiceChannelId() ?? null);
    },

    stop() {
        entries = [];
        inChannel.clear();
        current = null;
    }
});
