const template = `apiVersion: v1
data:
  key: value
kind: ConfigMap
metadata:
  creationTimestamp: null
  name: new-configmap
  namespace: default
`;

export default template;
