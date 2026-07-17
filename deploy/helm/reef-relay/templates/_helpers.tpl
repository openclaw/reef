{{- define "reef-relay.name" -}}
reef-relay
{{- end }}

{{- define "reef-relay.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "reef-relay.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "reef-relay.labels" -}}
app.kubernetes.io/name: {{ include "reef-relay.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "reef-relay.selectorLabels" -}}
app.kubernetes.io/name: {{ include "reef-relay.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "reef-relay.image" -}}
{{- $tag := required "image.tag is required and must identify an immutable image version" .Values.image.tag -}}
{{- if eq $tag "latest" -}}
{{- fail "image.tag must identify an immutable image version; latest is not allowed" -}}
{{- end -}}
{{ printf "%s:%s" .Values.image.repository $tag }}
{{- end }}

{{- define "reef-relay.databaseEnv" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.database.existingSecret }}
      key: {{ .Values.database.secretKey }}
{{- end }}
