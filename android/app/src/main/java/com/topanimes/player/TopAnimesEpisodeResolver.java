package com.topanimes.player;

import android.os.Build;
import android.text.Html;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class TopAnimesEpisodeResolver {
    private static final String TAG = "TopAnimesEpResolver";
    private static final String TOPANIMES_ORIGIN = "https://topanimes.net";
    private static final String DEFAULT_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

    private static final Pattern TAG_STRIP_PATTERN = Pattern.compile("<[^>]+>");
    private static final Pattern AD_HOST_PATTERN = Pattern.compile(
        "(?:^|[/._-])(?:ads?|vast|vmap|adserver|doubleclick|googlesyndication|supervideoad|yandex|tracker|metilinksemvoce|viewanalitycs|agl004|videoad|autotop|canalfutebol)(?:[/._?-]|$)",
        Pattern.CASE_INSENSITIVE
    );

    public static final class StreamCandidate {
        public final String label;
        public final int height;
        public final String url;
        public final String format;

        public StreamCandidate(String label, int height, String url, String format) {
            this.label = label;
            this.height = height;
            this.url = url;
            this.format = format;
        }
    }

    public static final class SubtitleCandidate {
        public final String label;
        public final String url;
        public final boolean isDefault;

        public SubtitleCandidate(String label, String url, boolean isDefault) {
            this.label = label;
            this.url = url;
            this.isDefault = isDefault;
        }
    }

    public static final class ServerOption {
        public final String nume;
        public final String label;
        public final String embedUrl;
        public final String providerKind;

        public ServerOption(String nume, String label, String embedUrl, String providerKind) {
            this.nume = nume;
            this.label = label;
            this.embedUrl = embedUrl;
            this.providerKind = providerKind;
        }
    }

    public static final class EpisodeLink {
        public final String numberLabel;
        public final int episodeNumber;
        public final String title;
        public final String url;

        public EpisodeLink(String numberLabel, int episodeNumber, String title, String url) {
            this.numberLabel = numberLabel;
            this.episodeNumber = episodeNumber;
            this.title = title;
            this.url = url;
        }
    }

    public static final class ResolvedEmbedData {
        public final boolean ok;
        public final String provider;
        public final String referer;
        public final boolean preferDirect;
        public final List<StreamCandidate> streams;
        public final List<SubtitleCandidate> subtitles;
        public final String errorMessage;

        public ResolvedEmbedData(
            boolean ok,
            String provider,
            String referer,
            boolean preferDirect,
            List<StreamCandidate> streams,
            List<SubtitleCandidate> subtitles,
            String errorMessage
        ) {
            this.ok = ok;
            this.provider = provider;
            this.referer = referer;
            this.preferDirect = preferDirect;
            this.streams = streams;
            this.subtitles = subtitles;
            this.errorMessage = errorMessage;
        }
    }

    public static final class ResolvedEpisodeData {
        public final String episodeUrl;
        public final String title;
        public final String seriesUrl;
        public final String prevUrl;
        public final String nextUrl;
        public final List<ServerOption> options;
        public final String selectedServerNume;
        public final String referer;
        public final boolean preferDirect;
        public final List<StreamCandidate> streams;
        public final List<SubtitleCandidate> subtitles;
        public final String errorMessage;

        public ResolvedEpisodeData(
            String episodeUrl,
            String title,
            String seriesUrl,
            String prevUrl,
            String nextUrl,
            List<ServerOption> options,
            String selectedServerNume,
            String referer,
            boolean preferDirect,
            List<StreamCandidate> streams,
            List<SubtitleCandidate> subtitles,
            String errorMessage
        ) {
            this.episodeUrl = episodeUrl;
            this.title = title;
            this.seriesUrl = seriesUrl;
            this.prevUrl = prevUrl;
            this.nextUrl = nextUrl;
            this.options = options;
            this.selectedServerNume = selectedServerNume;
            this.referer = referer;
            this.preferDirect = preferDirect;
            this.streams = streams;
            this.subtitles = subtitles;
            this.errorMessage = errorMessage;
        }
    }

    private TopAnimesEpisodeResolver() {
    }

    public static ResolvedEpisodeData resolveEpisode(String rawEpisodeUrl, String preferredNume) throws Exception {
        String episodeUrl = normalizeTopAnimesUrl(rawEpisodeUrl);
        if (episodeUrl.isEmpty()) {
            throw new IOException("URL de episódio inválida.");
        }

        String html = fetchText(episodeUrl, TOPANIMES_ORIGIN + "/", 11000);
        String title = extractEpisodeTitle(html);
        Map<String, String> sourceMap = extractSourcePlayerMap(html, episodeUrl);
        hydrateMissingDooPlayerSources(html, episodeUrl, sourceMap);
        List<ServerOption> options = extractServerOptions(html, sourceMap, episodeUrl);

        String seriesUrl = "";
        String prevUrl = "";
        String nextUrl = "";

        String pagBlock = extractDivInnerHtmlByClass(html, "pag_episodes");
        if (!pagBlock.isEmpty()) {
            Matcher links = Pattern.compile("<a[^>]+href=[\"']([^\"']+)[\"'][^>]*>([\\s\\S]*?)</a>", Pattern.CASE_INSENSITIVE).matcher(pagBlock);
            int idx = 0;
            while (links.find()) {
                String href = normalizeTopAnimesUrl(links.group(1));
                String text = cleanHtmlText(links.group(2)).toLowerCase(Locale.ROOT);
                if (!href.isEmpty()) {
                    if (href.toLowerCase(Locale.ROOT).contains("/animes/")) {
                        seriesUrl = href;
                    } else if (text.contains("anterior") || (idx == 0 && !text.contains("próximo") && !text.contains("proximo"))) {
                        prevUrl = href;
                    } else if (text.contains("próximo") || text.contains("proximo") || idx == 2) {
                        nextUrl = href;
                    }
                }
                idx++;
            }
        }

        if (seriesUrl.isEmpty()) {
            Matcher seriesLink = Pattern.compile("href=[\"']([^\"']*/animes/[^\"']+)[\"']", Pattern.CASE_INSENSITIVE).matcher(html);
            if (seriesLink.find()) {
                seriesUrl = normalizeTopAnimesUrl(seriesLink.group(1));
            }
        }

        if (options.isEmpty()) {
            return new ResolvedEpisodeData(
                episodeUrl,
                title,
                seriesUrl,
                prevUrl,
                nextUrl,
                options,
                "",
                TOPANIMES_ORIGIN + "/",
                false,
                Collections.emptyList(),
                Collections.emptyList(),
                "Nenhum servidor compatível encontrado neste episódio."
            );
        }

        List<ServerOption> ordered = orderOptionsForAttempt(options, preferredNume);
        ResolvedEmbedData bestEmbed = null;
        String chosenNume = ordered.get(0).nume;
        int bestQualityScore = -1;
        int bestProviderPrio = -1;

        for (int i = 0; i < ordered.size(); i++) {
            ServerOption opt = ordered.get(i);
            ResolvedEmbedData attempt = resolveEmbed(opt.embedUrl);
            if (attempt.ok && !attempt.streams.isEmpty()) {
                // If user's preferred server works right away, use it without extra round-trips
                if (i == 0 && preferredNume != null && preferredNume.equals(opt.nume)) {
                    bestEmbed = attempt;
                    chosenNume = opt.nume;
                    break;
                }
                int qScore = scoreEmbedQuality(attempt);
                int pScore = providerPriority(opt.providerKind);
                if (bestEmbed == null || !bestEmbed.ok || bestEmbed.streams.isEmpty()
                    || qScore > bestQualityScore
                    || (qScore == bestQualityScore && pScore > bestProviderPrio)) {
                    bestEmbed = attempt;
                    chosenNume = opt.nume;
                    bestQualityScore = qScore;
                    bestProviderPrio = pScore;
                }
                // On the first primary (non-preferred) attempt, stop only if it's already Full HD+; otherwise inspect fallbacks for best quality
                if (i == 0 && qScore >= 1080) {
                    break;
                }
            } else if (bestEmbed == null) {
                bestEmbed = attempt;
            }
        }

        if (bestEmbed == null || bestEmbed.streams.isEmpty()) {
            return new ResolvedEpisodeData(
                episodeUrl,
                title,
                seriesUrl,
                prevUrl,
                nextUrl,
                options,
                chosenNume,
                TOPANIMES_ORIGIN + "/",
                false,
                Collections.emptyList(),
                Collections.emptyList(),
                bestEmbed != null && !bestEmbed.errorMessage.isEmpty()
                    ? bestEmbed.errorMessage
                    : "Nenhum stream encontrado nos servidores deste episódio."
            );
        }

        return new ResolvedEpisodeData(
            episodeUrl,
            title,
            seriesUrl,
            prevUrl,
            nextUrl,
            options,
            chosenNume,
            bestEmbed.referer,
            bestEmbed.preferDirect,
            bestEmbed.streams,
            bestEmbed.subtitles,
            ""
        );
    }

    public static ResolvedEmbedData resolveEmbed(String rawEmbedUrl) {
        String cleanEmbed = unwrapAvisoUrl(rawEmbedUrl);
        if (cleanEmbed.isEmpty()) cleanEmbed = rawEmbedUrl != null ? rawEmbedUrl.trim() : "";
        String baseReferer = TOPANIMES_ORIGIN + "/";

        if (!isSafeHttpUrl(cleanEmbed)) {
            return new ResolvedEmbedData(false, "Servidor", baseReferer, false, Collections.emptyList(), Collections.emptyList(), "URL do servidor bloqueada.");
        }

        String lowerEmbed = cleanEmbed.toLowerCase(Locale.ROOT);
        if (lowerEmbed.contains("abyssplayer.com") || lowerEmbed.contains("abyss.to")
            || lowerEmbed.contains("abysscdn.com") || lowerEmbed.contains("short.icu")) {
            return new ResolvedEmbedData(false, "Aniplay", baseReferer, false, Collections.emptyList(), Collections.emptyList(), "Servidor indisponível.");
        }

        String fetchTarget = cleanEmbed;
        if (lowerEmbed.contains("sk-boyceta.booonceivu.shop")) {
            fetchTarget = cleanEmbed.contains("?")
                ? cleanEmbed + "&mode=to-salvando-seu-ip"
                : cleanEmbed + "?mode=to-salvando-seu-ip";
        }

        try {
            String body = fetchText(fetchTarget, baseReferer, 12000);
            ExtractedResult extracted = extractStreamsFromEmbed(cleanEmbed, body);

            if (extracted.streams.isEmpty()) {
                Matcher zuplayMatcher = Pattern.compile("^https?://csst\\.online/embed/(video/[^?#]+)", Pattern.CASE_INSENSITIVE).matcher(cleanEmbed);
                if (zuplayMatcher.find()) {
                    String videoPath = zuplayMatcher.group(1);
                    String fallbackUrl = "https://ru-boyceta.booonceivu.shop/?id=" + URLEncoder.encode(videoPath, "UTF-8");
                    String zBody = fetchText(fallbackUrl, baseReferer, 12000);
                    extracted = extractStreamsFromEmbed(fallbackUrl, zBody);
                }
            }

            if (extracted.streams.isEmpty()) {
                return new ResolvedEmbedData(
                    false,
                    extracted.provider,
                    cleanEmbed,
                    false,
                    Collections.emptyList(),
                    extracted.subtitles,
                    "Nenhum link de vídeo encontrado neste servidor."
                );
            }

            String streamReferer = lowerEmbed.contains("csst.online")
                ? "https://www.incvideo1.online/"
                : (lowerEmbed.contains("antivirus") || lowerEmbed.contains("booonceivu"))
                    ? baseReferer
                    : cleanEmbed;

            boolean preferDirect = false;
            try {
                String host = URI.create(extracted.streams.get(0).url).getHost();
                if (host != null) {
                    String lh = host.toLowerCase(Locale.ROOT);
                    preferDirect = lh.endsWith("booonceivu.shop")
                        || lh.endsWith("123flmsfree.com")
                        || lh.endsWith("321moviesfree.com");
                }
            } catch (Exception ignored) {
            }

            return new ResolvedEmbedData(
                true,
                extracted.provider,
                streamReferer,
                preferDirect,
                extracted.streams,
                extracted.subtitles,
                ""
            );
        } catch (Exception e) {
            return new ResolvedEmbedData(
                false,
                "Servidor",
                baseReferer,
                false,
                Collections.emptyList(),
                Collections.emptyList(),
                e.getMessage() != null ? e.getMessage() : "Falha ao consultar servidor."
            );
        }
    }

    public static List<EpisodeLink> fetchSeriesEpisodes(String rawSeriesUrl) {
        String seriesUrl = normalizeTopAnimesUrl(rawSeriesUrl);
        if (seriesUrl.isEmpty()) return Collections.emptyList();
        try {
            String html = fetchText(seriesUrl, TOPANIMES_ORIGIN + "/", 10000);
            List<EpisodeLink> list = new ArrayList<>();
            Matcher liMatcher = Pattern.compile(
                "<li[^>]*>([\\s\\S]*?)</li>",
                Pattern.CASE_INSENSITIVE
            ).matcher(html);

            int seasonsIdx = html.indexOf("id=\"seasons\"");
            if (seasonsIdx < 0) seasonsIdx = html.indexOf("id='seasons'");
            String scope = seasonsIdx >= 0 ? html.substring(seasonsIdx) : html;
            liMatcher = Pattern.compile("<li[^>]*>([\\s\\S]*?)</li>", Pattern.CASE_INSENSITIVE).matcher(scope);

            Set<String> seen = new HashSet<>();
            while (liMatcher.find()) {
                String li = liMatcher.group(1);
                if (!li.contains("episodiotitle")) continue;

                Matcher linkMatcher = Pattern.compile(
                    "class=[\"'][^\"']*episodiotitle[^\"']*[\"'][^>]*>[\\s\\S]*?<a[^>]+href=[\"']([^\"']+)[\"'][^>]*>([\\s\\S]*?)</a>",
                    Pattern.CASE_INSENSITIVE
                ).matcher(li);
                if (!linkMatcher.find()) continue;

                String epUrl = normalizeTopAnimesUrl(linkMatcher.group(1));
                if (epUrl.isEmpty() || !seen.add(epUrl)) continue;
                String epTitle = cleanHtmlText(linkMatcher.group(2));
                if (epTitle.isEmpty()) epTitle = "Episódio";

                String numberLabel = "";
                Matcher numMatcher = Pattern.compile("class=[\"'][^\"']*numerando[^\"']*[\"'][^>]*>([\\s\\S]*?)<", Pattern.CASE_INSENSITIVE).matcher(li);
                if (numMatcher.find()) {
                    numberLabel = cleanHtmlText(numMatcher.group(1));
                }

                int epNum = -1;
                Matcher epNumMatcher = Pattern.compile("class=[\"'][^\"']*epnumber[^\"']*[\"'][^>]*>([\\s\\S]*?)<", Pattern.CASE_INSENSITIVE).matcher(li);
                if (epNumMatcher.find()) {
                    try {
                        epNum = Integer.parseInt(cleanHtmlText(epNumMatcher.group(1)).replaceAll("[^0-9]", ""));
                    } catch (NumberFormatException ignored) {
                    }
                }
                if (numberLabel.isEmpty() && epNum > 0) {
                    numberLabel = String.valueOf(epNum);
                }

                list.add(new EpisodeLink(numberLabel, epNum, epTitle, epUrl));
            }
            return list;
        } catch (Exception e) {
            Log.w(TAG, "Failed fetching series episodes: " + e.getMessage());
            return Collections.emptyList();
        }
    }

    public static int providerPriority(String providerKind) {
        if ("kojima".equals(providerKind)) return 5;
        if ("zuplay".equals(providerKind)) return 4;
        if ("vidstreaming".equals(providerKind)) return 3;
        if ("playerjs".equals(providerKind)) return 2;
        if ("blogger".equals(providerKind) || "other".equals(providerKind)) return 1;
        return 0;
    }

    public static int scoreEmbedQuality(ResolvedEmbedData data) {
        if (data == null || !data.ok || data.streams == null || data.streams.isEmpty()) {
            return 0;
        }
        int best = 0;
        for (StreamCandidate sc : data.streams) {
            int score;
            if (sc.height > 0) {
                score = sc.height;
            } else if ("hls".equals(sc.format)
                || (sc.url != null && sc.url.toLowerCase(Locale.ROOT).contains(".m3u8"))) {
                score = 720;
            } else {
                score = 1;
            }
            if (score > best) best = score;
        }
        return best;
    }

    public static String getBestQualityLabel(ResolvedEmbedData data) {
        if (data == null || !data.ok || data.streams == null || data.streams.isEmpty()) {
            return "";
        }
        int bestScore = 0;
        String bestLabel = "";
        for (StreamCandidate sc : data.streams) {
            int score;
            if (sc.height > 0) {
                score = sc.height;
            } else if ("hls".equals(sc.format)
                || (sc.url != null && sc.url.toLowerCase(Locale.ROOT).contains(".m3u8"))) {
                score = 720;
            } else {
                score = 1;
            }
            if (score > bestScore) {
                bestScore = score;
                bestLabel = (sc.label != null && !sc.label.isEmpty())
                    ? sc.label
                    : (sc.height > 0 ? (sc.height + "p") : "Auto");
            }
        }
        return bestLabel;
    }

    private static String extractDivInnerHtmlByClass(String html, String classToken) {
        if (html == null || html.isEmpty() || classToken == null || classToken.isEmpty()) {
            return "";
        }
        Matcher openMatcher = Pattern.compile(
            "<div[^>]*class=[\"'][^\"']*\\b" + Pattern.quote(classToken) + "\\b[^\"']*[\"'][^>]*>",
            Pattern.CASE_INSENSITIVE
        ).matcher(html);
        if (!openMatcher.find()) {
            return "";
        }
        int contentStart = openMatcher.end();
        Matcher tagMatcher = Pattern.compile("</?div\\b[^>]*>", Pattern.CASE_INSENSITIVE).matcher(html);
        tagMatcher.region(contentStart, html.length());
        int depth = 1;
        while (tagMatcher.find()) {
            String tag = tagMatcher.group().toLowerCase(Locale.ROOT);
            if (tag.startsWith("</")) {
                depth--;
                if (depth == 0) {
                    return html.substring(contentStart, tagMatcher.start());
                }
            } else {
                depth++;
            }
        }
        return html.substring(contentStart, Math.min(html.length(), contentStart + 2500));
    }

    private static List<ServerOption> orderOptionsForAttempt(List<ServerOption> options, String preferredNume) {
        List<ServerOption> ordered = new ArrayList<>();
        if (preferredNume != null && !preferredNume.isEmpty()) {
            for (ServerOption o : options) {
                if (preferredNume.equals(o.nume)) ordered.add(o);
            }
        }
        for (ServerOption o : options) {
            if (!ordered.contains(o) && ("kojima".equals(o.providerKind) || "zuplay".equals(o.providerKind)
                || "vidstreaming".equals(o.providerKind) || "playerjs".equals(o.providerKind))) {
                ordered.add(o);
            }
        }
        for (ServerOption o : options) {
            if (!ordered.contains(o)) ordered.add(o);
        }
        return ordered;
    }

    private static String extractEpisodeTitle(String html) {
        Matcher his = Pattern.compile("id=[\"']titleHis[\"'][^>]*>([\\s\\S]*?)</", Pattern.CASE_INSENSITIVE).matcher(html);
        if (his.find()) {
            String t = cleanHtmlText(his.group(1));
            if (!t.isEmpty()) return t;
        }
        Matcher h1 = Pattern.compile("<h1[^>]*>([\\s\\S]*?)</h1>", Pattern.CASE_INSENSITIVE).matcher(html);
        if (h1.find()) {
            String t = cleanHtmlText(h1.group(1))
                .replaceFirst("(?i)^Assistir\\s+", "")
                .replaceFirst("(?i)\\s*-\\s*TopAnimes\\.net\\s*$", "")
                .trim();
            if (!t.isEmpty()) return t;
        }
        return "Episódio";
    }

    private static Map<String, String> extractSourcePlayerMap(String html, String baseUrl) {
        Map<String, String> map = new HashMap<>();
        Matcher sp = Pattern.compile(
            "id=[\"']source-player-([^\"']+)[\"'][^>]*>([\\s\\S]*?)</div>",
            Pattern.CASE_INSENSITIVE
        ).matcher(html);
        while (sp.find()) {
            String nume = sp.group(1);
            if (nume == null || nume.isEmpty() || "trailer".equalsIgnoreCase(nume)) continue;
            String block = sp.group(2);
            Matcher iframe = Pattern.compile(
                "<iframe[^>]+(?:src|data-src)=[\"']([^\"']+)[\"']",
                Pattern.CASE_INSENSITIVE
            ).matcher(block);
            if (iframe.find()) {
                String unwrapped = unwrapAvisoUrl(resolveRelativeUrl(baseUrl, iframe.group(1)));
                if (!unwrapped.isEmpty()) {
                    map.put(nume, unwrapped);
                }
            }
        }
        return map;
    }

    private static void hydrateMissingDooPlayerSources(
        String html,
        String episodeUrl,
        Map<String, String> sourceMap
    ) {
        if (html == null || html.isEmpty()) return;

        String ajaxUrl = TOPANIMES_ORIGIN + "/wp-admin/admin-ajax.php";
        String playerApi = TOPANIMES_ORIGIN + "/wp-json/dooplayer/v2/";
        String playMethod = "admin_ajax";

        Matcher cfgM = Pattern.compile("var\\s+dtAjax\\s*=\\s*(\\{[\\s\\S]*?\\});").matcher(html);
        if (cfgM.find()) {
            String cfgBlock = cfgM.group(1);
            Matcher uM = Pattern.compile("[\"']url[\"']\\s*:\\s*[\"']([^\"']+)[\"']").matcher(cfgBlock);
            if (uM.find()) {
                String norm = normalizeTopAnimesUrl(uM.group(1).replace("\\/", "/"));
                if (!norm.isEmpty()) ajaxUrl = norm;
            }
            Matcher aM = Pattern.compile("[\"']player_api[\"']\\s*:\\s*[\"']([^\"']+)[\"']").matcher(cfgBlock);
            if (aM.find()) {
                String norm = normalizeTopAnimesUrl(aM.group(1).replace("\\/", "/"));
                if (!norm.isEmpty()) playerApi = norm.endsWith("/") ? norm : (norm + "/");
            }
            Matcher mM = Pattern.compile("[\"']play_method[\"']\\s*:\\s*[\"']([^\"']+)[\"']").matcher(cfgBlock);
            if (mM.find() && "wp_json".equalsIgnoreCase(mM.group(1).trim())) {
                playMethod = "wp_json";
            }
        }

        Matcher li = Pattern.compile(
            "<li[^>]*class=[\"'][^\"']*dooplay_player_option[^\"']*[\"'][^>]*>([\\s\\S]*?)</li>",
            Pattern.CASE_INSENSITIVE
        ).matcher(html);

        while (li.find()) {
            String fullTag = li.group(0);
            String inner = li.group(1);

            Matcher numeM = Pattern.compile("data-nume=[\"']([^\"']+)[\"']", Pattern.CASE_INSENSITIVE).matcher(fullTag);
            Matcher postM = Pattern.compile("data-post=[\"']([^\"']+)[\"']", Pattern.CASE_INSENSITIVE).matcher(fullTag);
            if (!numeM.find() || !postM.find()) continue;

            String nume = numeM.group(1).trim();
            String post = postM.group(1).trim();
            if (nume.isEmpty() || post.isEmpty() || "trailer".equalsIgnoreCase(nume) || sourceMap.containsKey(nume)) {
                continue;
            }

            String type = "tv";
            Matcher typeM = Pattern.compile("data-type=[\"']([^\"']+)[\"']", Pattern.CASE_INSENSITIVE).matcher(fullTag);
            if (typeM.find() && !typeM.group(1).trim().isEmpty()) {
                type = typeM.group(1).trim();
            }

            String label = "Servidor " + nume;
            Matcher titleM = Pattern.compile("class=[\"'][^\"']*title[^\"']*[\"'][^>]*>([\\s\\S]*?)<", Pattern.CASE_INSENSITIVE).matcher(inner);
            if (titleM.find()) {
                label = formatServerLabel(cleanHtmlText(titleM.group(1)), label);
            }
            if ("abyss".equals(classifyProviderKind(label, ""))) continue;

            String resolvedUrl = resolveDooPlayerAjaxOption(ajaxUrl, playerApi, playMethod, episodeUrl, post, nume, type);
            if (!resolvedUrl.isEmpty()) {
                sourceMap.put(nume, resolvedUrl);
            }
        }
    }

    private static String resolveDooPlayerAjaxOption(
        String ajaxUrl,
        String playerApi,
        String playMethod,
        String episodeUrl,
        String post,
        String nume,
        String type
    ) {
        boolean preferWpJson = "wp_json".equalsIgnoreCase(playMethod);
        for (int attempt = 0; attempt < 2; attempt++) {
            boolean useWpJson = (attempt == 0) == preferWpJson;
            try {
                String body;
                if (useWpJson) {
                    String target = playerApi
                        + URLEncoder.encode(post, "UTF-8") + "/"
                        + URLEncoder.encode(type, "UTF-8") + "/"
                        + URLEncoder.encode(nume, "UTF-8");
                    body = fetchText(target, episodeUrl, 8000);
                } else {
                    String form = "action=doo_player_ajax&post=" + URLEncoder.encode(post, "UTF-8")
                        + "&nume=" + URLEncoder.encode(nume, "UTF-8")
                        + "&type=" + URLEncoder.encode(type, "UTF-8");
                    body = postFormText(ajaxUrl, episodeUrl, form, 8000);
                }
                String extracted = parseDooPlayerAjaxResponse(body, episodeUrl);
                if (!extracted.isEmpty()) {
                    return extracted;
                }
            } catch (Exception ignored) {
                // Fall back to alternate DooPlay player method
            }
        }
        return "";
    }

    private static String parseDooPlayerAjaxResponse(String body, String baseUrl) {
        if (body == null) return "";
        String trimmed = body.trim();
        if (trimmed.isEmpty()) return "";

        String rawTarget = "";
        if (trimmed.startsWith("{")) {
            try {
                JSONObject json = new JSONObject(trimmed);
                rawTarget = json.optString("embed_url", "");
                if (rawTarget.isEmpty()) {
                    rawTarget = json.optString("url", "");
                }
            } catch (Exception e) {
                return "";
            }
        } else {
            rawTarget = trimmed;
        }
        rawTarget = rawTarget.trim();
        if (rawTarget.isEmpty()) return "";

        if (rawTarget.toLowerCase(Locale.ROOT).contains("<iframe")) {
            Matcher iframeM = Pattern.compile(
                "<iframe[^>]+(?:src|data-src)=[\"']([^\"']+)[\"']",
                Pattern.CASE_INSENSITIVE
            ).matcher(rawTarget);
            rawTarget = iframeM.find() ? iframeM.group(1).trim() : "";
        }
        if (rawTarget.isEmpty()) return "";

        return unwrapAvisoUrl(resolveRelativeUrl(baseUrl, rawTarget));
    }

    private static List<ServerOption> extractServerOptions(String html, Map<String, String> sourceMap, String baseUrl) {
        List<ServerOption> options = new ArrayList<>();
        Matcher li = Pattern.compile(
            "<li[^>]*class=[\"'][^\"']*dooplay_player_option[^\"']*[\"'][^>]*>([\\s\\S]*?)</li>",
            Pattern.CASE_INSENSITIVE
        ).matcher(html);

        while (li.find()) {
            String fullTag = li.group(0);
            String inner = li.group(1);
            Matcher numeM = Pattern.compile("data-nume=[\"']([^\"']+)[\"']", Pattern.CASE_INSENSITIVE).matcher(fullTag);
            if (!numeM.find()) continue;
            String nume = numeM.group(1).trim();
            if (nume.isEmpty() || "trailer".equalsIgnoreCase(nume)) continue;

            String label = "Servidor " + nume;
            Matcher titleM = Pattern.compile("class=[\"'][^\"']*title[^\"']*[\"'][^>]*>([\\s\\S]*?)<", Pattern.CASE_INSENSITIVE).matcher(inner);
            if (titleM.find()) {
                label = formatServerLabel(cleanHtmlText(titleM.group(1)), label);
            }

            String embedUrl = sourceMap.get(nume);
            if (embedUrl == null || embedUrl.isEmpty()) continue;
            String kind = classifyProviderKind(label, embedUrl);
            if ("abyss".equals(kind)) continue;
            options.add(new ServerOption(nume, label, embedUrl, kind));
        }

        if (options.isEmpty()) {
            Matcher protectM = Pattern.compile("data-player-url=[\"']([^\"']+)[\"']", Pattern.CASE_INSENSITIVE).matcher(html);
            if (protectM.find()) {
                String url = unwrapAvisoUrl(resolveRelativeUrl(baseUrl, protectM.group(1)));
                if (!url.isEmpty()) {
                    options.add(new ServerOption("1", "Servidor Principal", url, classifyProviderKind("", url)));
                }
            }
        }
        return options;
    }

    private static String formatServerLabel(String raw, String fallback) {
        if (raw == null) return fallback;
        String clean = raw.trim();
        if (clean.isEmpty()) return fallback;
        return clean.substring(0, 1).toUpperCase(Locale.ROOT) + clean.substring(1);
    }

    private static String classifyProviderKind(String label, String embedUrl) {
        String lu = embedUrl.toLowerCase(Locale.ROOT);
        String ll = label.toLowerCase(Locale.ROOT);
        if (lu.contains("/antivirus") || ll.contains("kojima")) return "kojima";
        if (lu.contains("sk-boyceta") || ll.contains("vidstreaming")) return "vidstreaming";
        if (lu.contains("booonceivu") || ll.contains("zuplay")) return "zuplay";
        if (lu.contains("csst.online") || ll.contains("ruplay")) return "playerjs";
        if (lu.contains("abyss") || lu.contains("short.icu") || ll.contains("aniplay")) return "abyss";
        if (lu.contains("blogger.com/video.g") || "bg".equals(ll)) return "blogger";
        return "other";
    }

    private static final class ExtractedResult {
        final List<StreamCandidate> streams;
        final List<SubtitleCandidate> subtitles;
        final String provider;

        ExtractedResult(List<StreamCandidate> streams, List<SubtitleCandidate> subtitles, String provider) {
            this.streams = streams;
            this.subtitles = subtitles;
            this.provider = provider;
        }
    }

    private static ExtractedResult extractStreamsFromEmbed(String embedUrl, String body) {
        List<StreamCandidate> streams = new ArrayList<>();
        List<SubtitleCandidate> subtitles = new ArrayList<>();
        String trimmed = body != null ? body.trim() : "";

        // 1. Vidstreaming JSON
        if (trimmed.startsWith("{")) {
            try {
                JSONObject json = new JSONObject(trimmed);
                JSONArray midias = json.optJSONArray("midias");
                if (midias != null) {
                    for (int i = 0; i < midias.length(); i++) {
                        JSONObject m = midias.optJSONObject(i);
                        if (m == null) continue;
                        String rawUrl = m.optString("url", "");
                        if (rawUrl.isEmpty()) continue;
                        String abs = resolveRelativeUrl(embedUrl, rawUrl);
                        String q = m.optString("qualidade", "");
                        String fmt = guessStreamFormat(abs, "");
                        int h = labelToHeight(q, abs);
                        streams.add(new StreamCandidate(formatQualityLabel(q, h, fmt), h, abs, fmt));
                    }
                    JSONArray legendas = json.optJSONArray("legendas");
                    if (legendas != null) {
                        for (int i = 0; i < legendas.length(); i++) {
                            JSONObject s = legendas.optJSONObject(i);
                            if (s == null) continue;
                            String rawUrl = s.optString("url", "");
                            if (rawUrl.isEmpty()) continue;
                            String abs = resolveRelativeUrl(embedUrl, rawUrl);
                            String lbl = s.optString("label", "Legenda");
                            boolean def = s.optBoolean("default", false) || lbl.toLowerCase(Locale.ROOT).matches(".*(portugu[eê]s|pt[-_]?br).*");
                            subtitles.add(new SubtitleCandidate(lbl.isEmpty() ? "Legenda" : lbl, abs, def));
                        }
                    }
                    return new ExtractedResult(dedupeAndSortStreams(streams), dedupeSubtitles(subtitles), "Vidstreaming");
                }
            } catch (Exception ignored) {
            }
        }

        // 2. Playerjs
        Matcher pjs = Pattern.compile("Playerjs\\s*\\(\\s*(\\{[\\s\\S]*?\\})\\s*\\)", Pattern.CASE_INSENSITIVE).matcher(trimmed);
        while (pjs.find()) {
            String block = pjs.group(1);
            Matcher fileM = Pattern.compile("file\\s*:\\s*(['\"])([\\s\\S]*?)\\1").matcher(block);
            if (fileM.find()) {
                String fileVal = fileM.group(2);
                if (fileVal != null && !fileVal.startsWith("#")) {
                    String[] parts = fileVal.split(",\\s*(?=\\[|https?://|//)|\\s+or\\s+");
                    for (String part : parts) {
                        Matcher pm = Pattern.compile("^(?:\\[([^\\]]+)\\])?\\s*(.+)$").matcher(part.trim());
                        if (!pm.find()) continue;
                        String abs = resolveRelativeUrl(embedUrl, pm.group(2).trim());
                        if (!isSafeHttpUrl(abs)) continue;
                        String lbl = pm.group(1) != null ? pm.group(1).trim() : "";
                        String fmt = guessStreamFormat(abs, "");
                        int h = labelToHeight(lbl, abs);
                        streams.add(new StreamCandidate(formatQualityLabel(lbl, h, fmt), h, abs, fmt));
                    }
                }
            }
            Matcher subM = Pattern.compile("subtitles?\\s*:\\s*(['\"])([\\s\\S]*?)\\1").matcher(block);
            if (subM.find()) {
                String subVal = subM.group(2);
                if (subVal != null) {
                    String[] parts = subVal.split(",\\s*(?=\\[|https?://|//)");
                    for (String part : parts) {
                        Matcher sm = Pattern.compile("^(?:\\[([^\\]]+)\\])?\\s*(.+)$").matcher(part.trim());
                        if (!sm.find()) continue;
                        String abs = resolveRelativeUrl(embedUrl, sm.group(2).trim());
                        if (!isSafeHttpUrl(abs)) continue;
                        String lbl = sm.group(1) != null && !sm.group(1).trim().isEmpty() ? sm.group(1).trim() : "Legenda";
                        boolean def = lbl.toLowerCase(Locale.ROOT).matches(".*(portugu[eê]s|pt[-_]?br).*");
                        subtitles.add(new SubtitleCandidate(lbl, abs, def));
                    }
                }
            }
            if (!streams.isEmpty()) {
                return new ExtractedResult(dedupeAndSortStreams(streams), dedupeSubtitles(subtitles), "Playerjs");
            }
        }

        // 3. Blogger
        if (trimmed.contains("googlevideo.com/videoplayback")) {
            String unescaped = unescapeUnicode(trimmed);
            Matcher bm = Pattern.compile("\\[\"(https://[^\"\\s]+?googlevideo\\.com/videoplayback\\?[^\"\\s]+)\",\\[(\\d+)\\]\\]").matcher(unescaped);
            while (bm.find()) {
                int itag = 0;
                try {
                    itag = Integer.parseInt(bm.group(2));
                } catch (NumberFormatException ignored) {
                }
                int h = itagToHeight(itag);
                streams.add(new StreamCandidate(h > 0 ? (h + "p") : ("itag " + itag), h, bm.group(1), "mp4"));
            }
            if (!streams.isEmpty()) {
                return new ExtractedResult(dedupeAndSortStreams(streams), Collections.emptyList(), "Blogger");
            }
        }

        // 4. JW Player (`jwplayer(...).setup({ sources: [...], tracks: [...] })`)
        Matcher jwSourcesM = Pattern.compile("sources\\s*:\\s*(\\[[\\s\\S]*?\\])", Pattern.CASE_INSENSITIVE).matcher(trimmed);
        if (jwSourcesM.find()) {
            JSONArray parsedSources = parseLooseJsArray(jwSourcesM.group(1));
            if (parsedSources != null) {
                for (int i = 0; i < parsedSources.length(); i++) {
                    JSONObject s = parsedSources.optJSONObject(i);
                    if (s == null) continue;
                    String rawUrl = s.optString("file", "");
                    if (rawUrl.isEmpty()) rawUrl = s.optString("src", "");
                    if (rawUrl.isEmpty()) rawUrl = s.optString("url", "");
                    if (rawUrl.isEmpty()) continue;
                    String abs = resolveRelativeUrl(embedUrl, rawUrl);
                    if (!isSafeHttpUrl(abs)) continue;
                    String rawLabel = s.optString("label", "");
                    String rawType = s.optString("type", "");
                    String fmt = guessStreamFormat(abs, rawType);
                    int h = labelToHeight(rawLabel, abs);
                    streams.add(new StreamCandidate(formatQualityLabel(rawLabel, h, fmt), h, abs, fmt));
                }
            }
        }

        Matcher jwTracksM = Pattern.compile("tracks\\s*:\\s*(\\[[\\s\\S]*?\\])", Pattern.CASE_INSENSITIVE).matcher(trimmed);
        if (jwTracksM.find()) {
            JSONArray parsedTracks = parseLooseJsArray(jwTracksM.group(1));
            if (parsedTracks != null) {
                for (int i = 0; i < parsedTracks.length(); i++) {
                    JSONObject t = parsedTracks.optJSONObject(i);
                    if (t == null) continue;
                    String kind = t.optString("kind", "");
                    if (!kind.isEmpty() && !kind.toLowerCase(Locale.ROOT).matches(".*(captions|subtitles).*")) {
                        continue;
                    }
                    String rawFile = t.optString("file", "");
                    if (rawFile.isEmpty()) continue;
                    String abs = resolveRelativeUrl(embedUrl, rawFile);
                    if (!isSafeHttpUrl(abs)) continue;
                    String lbl = t.optString("label", "Legenda");
                    if (lbl.isEmpty()) lbl = "Legenda";
                    boolean def = t.optBoolean("default", false)
                        || lbl.toLowerCase(Locale.ROOT).matches(".*(portugu[eê]s|pt[-_]?br).*");
                    subtitles.add(new SubtitleCandidate(lbl, abs, def));
                }
            }
        }

        // 5. Fallback direct .m3u8 / .mp4 scan
        if (streams.isEmpty()) {
            Matcher urlM = Pattern.compile("https?://[^\"'\\\\\\s<>]+?(?:\\.m3u8|\\.mp4)(?:\\?[^\"'\\\\\\s<>]*)?", Pattern.CASE_INSENSITIVE).matcher(trimmed);
            while (urlM.find()) {
                String found = urlM.group(0);
                if (AD_HOST_PATTERN.matcher(found).find()) continue;
                String fmt = guessStreamFormat(found, "");
                int h = labelToHeight("", found);
                streams.add(new StreamCandidate(formatQualityLabel("", h, fmt), h, found, fmt));
            }
        }

        String provider = embedUrl.contains("booonceivu.shop")
            ? "Zuplay"
            : embedUrl.contains("antivirus")
                ? "KojimaCDN"
                : "Direto";

        return new ExtractedResult(dedupeAndSortStreams(streams), dedupeSubtitles(subtitles), provider);
    }

    private static JSONArray parseLooseJsArray(String raw) {
        if (raw == null || raw.trim().isEmpty()) return null;
        try {
            return new JSONArray(raw);
        } catch (Exception ignored) {
            // Normalize loose JS object syntax (unquoted keys, single quotes, trailing commas)
        }
        try {
            String normalized = raw.replaceAll("([{,]\\s*)([a-zA-Z0-9_]+)\\s*:", "$1\"$2\":");
            Matcher singleQuoted = Pattern.compile("'([^'\\\\]*(?:\\\\.[^'\\\\]*)*)'").matcher(normalized);
            StringBuffer sb = new StringBuffer();
            while (singleQuoted.find()) {
                String inner = singleQuoted.group(1).replace("\\'", "'").replace("\"", "\\\"");
                singleQuoted.appendReplacement(sb, Matcher.quoteReplacement("\"" + inner + "\""));
            }
            singleQuoted.appendTail(sb);
            normalized = sb.toString().replaceAll(",\\s*([}\\]])", "$1");
            return new JSONArray(normalized);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static List<StreamCandidate> dedupeAndSortStreams(List<StreamCandidate> list) {
        Set<String> seen = new HashSet<>();
        List<StreamCandidate> out = new ArrayList<>();
        for (StreamCandidate item : list) {
            if (!isSafeHttpUrl(item.url) || AD_HOST_PATTERN.matcher(item.url).find()) continue;
            if (!seen.add(item.url)) continue;
            out.add(item);
        }
        Collections.sort(out, (a, b) -> Integer.compare(b.height, a.height));
        return out;
    }

    private static List<SubtitleCandidate> dedupeSubtitles(List<SubtitleCandidate> list) {
        Set<String> seen = new HashSet<>();
        List<SubtitleCandidate> out = new ArrayList<>();
        for (SubtitleCandidate item : list) {
            if (!isSafeHttpUrl(item.url) || !seen.add(item.url)) continue;
            out.add(item);
        }
        return out;
    }

    private static int itagToHeight(int itag) {
        switch (itag) {
            case 38: return 2160;
            case 37:
            case 46: return 1080;
            case 22:
            case 45: return 720;
            case 35:
            case 44:
            case 59:
            case 78: return 480;
            case 18:
            case 34:
            case 43: return 360;
            case 6: return 270;
            case 5:
            case 36: return 240;
            case 13:
            case 17: return 144;
            default: return 0;
        }
    }

    private static int labelToHeight(String label, String url) {
        String clean = label != null ? label.trim().toLowerCase(Locale.ROOT) : "";
        Matcher m = Pattern.compile("(\\d{3,4})\\s*p?").matcher(clean);
        if (m.find()) {
            try {
                return Integer.parseInt(m.group(1));
            } catch (NumberFormatException ignored) {
            }
        }
        switch (clean) {
            case "uhd":
            case "4k": return 2160;
            case "2k":
            case "qhd": return 1440;
            case "fhd": return 1080;
            case "hd": return 720;
            case "sd": return 480;
            case "ld": return 360;
            case "fd": return 240;
            default: break;
        }
        Matcher um = Pattern.compile("(?:^|\\D)(2160|1440|1080|720|480|360|240)p?(?:\\D|$)").matcher(url != null ? url : "");
        if (um.find()) {
            try {
                return Integer.parseInt(um.group(1));
            } catch (NumberFormatException ignored) {
            }
        }
        return 0;
    }

    private static String guessStreamFormat(String url, String hint) {
        String lower = (url != null ? url : "").toLowerCase(Locale.ROOT);
        String lowerHint = (hint != null ? hint : "").toLowerCase(Locale.ROOT);
        if (lower.contains(".m3u8") || lowerHint.contains("hls") || lowerHint.contains("mpegurl") || lowerHint.contains("m3u8")) {
            return "hls";
        }
        if (lower.contains(".mp4") || lower.contains(".webm") || lower.contains(".m4v") || lower.contains("videoplayback") || lowerHint.contains("mp4")) {
            return "mp4";
        }
        return "unknown";
    }

    private static String formatQualityLabel(String rawLabel, int height, String format) {
        String clean = rawLabel != null ? rawLabel.trim() : "";
        if (clean.matches("(?i)^\\d{3,4}p$")) return clean;
        if (height > 0 && !clean.isEmpty()) return clean + " (" + height + "p)";
        if (height > 0) return height + "p";
        if (!clean.isEmpty()) return clean;
        return "hls".equals(format) ? "HLS Auto" : "Original";
    }

    private static String fetchText(String rawUrl, String referer, int timeoutMs) throws IOException {
        String currentUrl = rawUrl;
        HttpURLConnection conn = null;
        try {
            for (int hop = 0; hop <= 4; hop++) {
                if (!isSafeHttpUrl(currentUrl)) {
                    throw new IOException("URL bloqueada.");
                }
                URL parsed = new URL(currentUrl);
                conn = (HttpURLConnection) parsed.openConnection();
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(timeoutMs);
                conn.setReadTimeout(timeoutMs);
                conn.setRequestProperty("User-Agent", DEFAULT_UA);
                conn.setRequestProperty("Accept", "text/html,application/xhtml+xml,application/json,*/*;q=0.9");
                conn.setRequestProperty("Accept-Language", "pt-BR,pt;q=0.9,en;q=0.8");
                if (referer != null && isSafeHttpUrl(referer)) {
                    conn.setRequestProperty("Referer", referer);
                }

                int code = conn.getResponseCode();
                if (code >= 300 && code < 400) {
                    String loc = conn.getHeaderField("Location");
                    conn.disconnect();
                    if (loc == null || loc.isEmpty()) {
                        throw new IOException("Redirecionamento vazio.");
                    }
                    currentUrl = new URL(parsed, loc).toString();
                    continue;
                }
                if (code < 200 || code >= 300) {
                    throw new IOException("Servidor retornou HTTP " + code);
                }

                ByteArrayOutputStream out = new ByteArrayOutputStream();
                try (InputStream in = conn.getInputStream()) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        out.write(buf, 0, n);
                    }
                }
                return out.toString(StandardCharsets.UTF_8.name());
            }
            throw new IOException("Excesso de redirecionamentos.");
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String postFormText(String rawUrl, String referer, String formBody, int timeoutMs) throws IOException {
        if (!isSafeHttpUrl(rawUrl)) {
            throw new IOException("URL bloqueada.");
        }
        HttpURLConnection conn = null;
        try {
            URL parsed = new URL(rawUrl);
            conn = (HttpURLConnection) parsed.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            conn.setRequestMethod("POST");
            conn.setRequestProperty("User-Agent", DEFAULT_UA);
            conn.setRequestProperty("Accept", "application/json,text/html,*/*;q=0.9");
            conn.setRequestProperty("Accept-Language", "pt-BR,pt;q=0.9,en;q=0.8");
            conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
            conn.setRequestProperty("X-Requested-With", "XMLHttpRequest");
            if (referer != null && isSafeHttpUrl(referer)) {
                conn.setRequestProperty("Referer", referer);
            }
            byte[] payload = (formBody != null ? formBody : "").getBytes(StandardCharsets.UTF_8);
            conn.setDoOutput(true);
            conn.setFixedLengthStreamingMode(payload.length);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(payload);
            }

            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                throw new IOException("Servidor retornou HTTP " + code);
            }

            ByteArrayOutputStream out = new ByteArrayOutputStream();
            try (InputStream in = conn.getInputStream()) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) != -1) {
                    out.write(buf, 0, n);
                }
            }
            return out.toString(StandardCharsets.UTF_8.name());
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String unwrapAvisoUrl(String rawUrl) {
        if (rawUrl == null || rawUrl.trim().isEmpty() || "about:blank".equals(rawUrl)) return "";
        String candidate = rawUrl.trim();
        try {
            URI uri = URI.create(candidate);
            String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.ROOT) : "";
            String path = uri.getPath() != null ? uri.getPath() : "";
            if (("topanimes.net".equals(host) || "www.topanimes.net".equals(host)) && path.matches("^/aviso/?$")) {
                String query = uri.getRawQuery();
                if (query != null) {
                    for (String pair : query.split("&")) {
                        int eq = pair.indexOf('=');
                        if (eq > 0 && "url".equals(pair.substring(0, eq))) {
                            candidate = URLDecoder.decode(pair.substring(eq + 1), "UTF-8").trim();
                            break;
                        }
                    }
                }
            }
            URI cleaned = URI.create(candidate);
            if ((cleaned.getRawQuery() == null || cleaned.getRawQuery().isEmpty()) && cleaned.getPath() != null && cleaned.getPath().contains("&")) {
                int idx = candidate.indexOf('&');
                if (idx > 0) candidate = candidate.substring(0, idx);
            }
        } catch (Exception ignored) {
        }
        return isSafeHttpUrl(candidate) ? candidate : "";
    }

    private static String resolveRelativeUrl(String baseUrl, String raw) {
        if (raw == null || raw.trim().isEmpty()) return "";
        try {
            return new URL(new URL(baseUrl), raw.trim()).toString();
        } catch (Exception e) {
            return raw.trim();
        }
    }

    public static String normalizeTopAnimesUrl(String rawUrl) {
        if (rawUrl == null) return "";
        String trimmed = rawUrl.trim();
        if (trimmed.isEmpty() || "#".equals(trimmed) || trimmed.startsWith("javascript:")) return "";
        try {
            URL resolved = new URL(new URL(TOPANIMES_ORIGIN + "/"), trimmed);
            String host = resolved.getHost() != null ? resolved.getHost().toLowerCase(Locale.ROOT) : "";
            if ("topanimes.net".equals(host) || "www.topanimes.net".equals(host)) {
                return resolved.toString();
            }
        } catch (Exception ignored) {
        }
        return "";
    }

    private static boolean isSafeHttpUrl(String rawUrl) {
        if (rawUrl == null || rawUrl.trim().isEmpty()) return false;
        try {
            URI uri = URI.create(rawUrl.trim());
            String scheme = uri.getScheme() != null ? uri.getScheme().toLowerCase(Locale.ROOT) : "";
            if (!"http".equals(scheme) && !"https".equals(scheme)) return false;
            String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.ROOT) : "";
            if (host.isEmpty()) return false;
            return !host.equals("localhost") && !host.equals("127.0.0.1") && !host.equals("::1");
        } catch (Exception e) {
            return false;
        }
    }

    private static String cleanHtmlText(String raw) {
        if (raw == null || raw.isEmpty()) return "";
        String noTags = TAG_STRIP_PATTERN.matcher(raw).replaceAll(" ");
        String decoded;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            decoded = Html.fromHtml(noTags, Html.FROM_HTML_MODE_LEGACY).toString();
        } else {
            decoded = Html.fromHtml(noTags).toString();
        }
        return decoded.replace('\u00A0', ' ').replaceAll("\\s+", " ").trim();
    }

    private static String unescapeUnicode(String input) {
        Matcher m = Pattern.compile("\\\\u([0-9a-fA-F]{4})").matcher(input);
        StringBuffer sb = new StringBuffer();
        while (m.find()) {
            char ch = (char) Integer.parseInt(m.group(1), 16);
            m.appendReplacement(sb, Matcher.quoteReplacement(String.valueOf(ch)));
        }
        m.appendTail(sb);
        return sb.toString();
    }
}
